# SPEC-009 — Vídeo remoto: anexar o elemento real e consertar o `adaptiveStream`

## 1. Problema

**Causa raiz:** RC-12 — a mais provável causa do "loading infinito ao clicar
para ver a tela". Também A8 (elementos de mídia órfãos no DOM).

`client/ui/src/rtc.ts:182-183` faz:

```ts
const element = track.attach() as HTMLMediaElement;
element.autoplay = true; element.style.display = "none"; document.body.appendChild(element);
```

O `Room` é criado com `adaptiveStream: true` (`rtc.ts:282`). Com essa opção, o
`RemoteVideoTrack` observa os elementos passados a `attach()` e reporta a
visibilidade ao SFU (`livekit-client.esm.mjs:15486-15511`). E
`isElementInViewport` devolve `false` quando `display === 'none'`
(`livekit-client.esm.mjs:15760-15768`). O caminho termina em
`sendUpdateTrackSettings({ disabled: true })` (`:33064`, `:32980`).

Ou seja: **para todo vídeo remoto, o cliente diz ao SFU que a track está
invisível, e o SFU para de enviar.** O `<video>` que o usuário vê é outro
elemento, criado pelo React (`App.tsx:641-651`), que recebe `srcObject`
diretamente e do qual o SDK não sabe nada.

**Sintomas que desaparecem:** 4 (loading infinito, preview morto, tela que
congela), e telas de câmera que param sozinhas.

## 2. Prioridade e dependências

- **Prioridade:** P0
- **Dependências:** SPEC-007 (`callSession` para registro de recursos),
  SPEC-008 (`voiceStore` para saber que track pertence a quem).

## 3. Arquivos afetados

| Arquivo | Ação |
|---|---|
| `client/ui/src/rtc.ts` | editar: `TrackSubscribed` / `Unsubscribed` param de criar elementos de vídeo |
| `client/ui/src/remoteMedia.ts` | criar: registro de tracks remotas vivas |
| `client/ui/src/App.tsx` | editar: `VideoTile` e `MiniVideo` passam a usar `attach`/`detach` |
| `client/ui/src/remoteMedia.test.ts` | criar |

## 4. Mudança especificada

### 4.1 O princípio

O elemento `<video>` que o usuário vê **é** o elemento que o SDK observa.
Nenhum `srcObject` manual para vídeo remoto; nenhum elemento escondido.

Áudio remoto continua com elemento escondido no `body` (o usuário não vê áudio,
e `adaptiveStream` não gerencia áudio), mas passa a ser registrado como recurso
da sessão para não vazar (A8).

### 4.2 `client/ui/src/remoteMedia.ts` (novo)

```ts
/**
 * Registro das tracks de vídeo remotas vivas, para que os componentes possam
 * anexá-las ao seu próprio <video>.
 *
 * Por que não guardar MediaStream: com adaptiveStream, o LiveKit precisa
 * observar o elemento que o usuário realmente vê. Só `track.attach(element)`
 * registra esse elemento (livekit-client.esm.mjs:15486). Passar
 * `srcObject` por fora faz o SDK reportar "invisível" e o SFU parar de enviar
 * (tupi-v2-refactor/02-root-cause-analysis.md RC-12).
 */
import type { RemoteTrack, RemoteVideoTrack } from "livekit-client";

export type RemoteVideo = {
  /** Identidade Tupi do dono. */
  ownerId: string;
  trackSid: string;
  /** "camera" | "screen_share" — derivado de publication.source. */
  source: "camera" | "screen_share";
  track: RemoteVideoTrack;
};

/** Chave: trackSid. */
const videos = new Map<string, RemoteVideo>();
const listeners = new Set<(videos: RemoteVideo[]) => void>();

export function addRemoteVideo(entry: RemoteVideo): void;
export function removeRemoteVideo(trackSid: string): void;
export function clearRemoteVideos(): void;
export function getRemoteVideos(): RemoteVideo[];
export function subscribeRemoteVideos(listener: (videos: RemoteVideo[]) => void): () => void;

/** Procura o vídeo de um dono por tipo. Substitui pickRemoteVideo do App.tsx,
 *  que decidia por msid e errava quando o msid estava obsoleto (RC-03). */
export function findRemoteVideo(ownerId: string, source: "camera" | "screen_share"): RemoteVideo | undefined;
```

A classificação câmera versus tela passa a vir de `publication.source` do
LiveKit, que é a fonte correta e sempre atual, em vez de casar `msid` contra a
lista de streams do servidor (`App.tsx:2664-2671`). Isso remove uma classe
inteira de bug: mesmo que a projeção do servidor esteja atrasada, o vídeo é
classificado certo.

### 4.3 `rtc.ts` — `TrackSubscribed`

```ts
room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
  if (!callSession.isCurrent(sessionId)) return;

  if (track.kind === Track.Kind.Video) {
    const source = publication.source === Track.Source.Camera ? "camera" : "screen_share";
    // NÃO chamar track.attach() aqui. O componente que exibe é quem anexa,
    // para que o SDK observe o elemento visível (RC-12).
    remoteMedia.addRemoteVideo({
      ownerId: participant.identity,
      trackSid: publication.trackSid,
      source,
      track: track as RemoteVideoTrack,
    });
    logClient("watch.subscribed", { owner: participant.identity, track_sid: publication.trackSid });
    return;
  }

  // Áudio: elemento escondido, como hoje, mas registrado como recurso.
  const element = track.attach() as HTMLAudioElement;
  element.autoplay = true;
  element.style.display = "none";
  document.body.appendChild(element);
  const isScreenAudio = publication.source === Track.Source.ScreenShareAudio;
  const sinks = isScreenAudio ? screenAudio : audio;
  sinks.set(participant.identity, [...(sinks.get(participant.identity) || []), element]);
  apply(participant.identity, isScreenAudio);
});

room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
  if (track.kind === Track.Kind.Video) {
    remoteMedia.removeRemoteVideo(publication.trackSid);
    return;
  }
  const detached = track.detach() as HTMLMediaElement[];
  detached.forEach(element => element.remove());
  // ... limpeza dos mapas, igual a hoje ...
});
```

E registrar a limpeza global como recurso da sessão (SPEC-007 §4.3 já reserva o
lugar):

```ts
callSession.registerResource(sessionId, () => {
  remoteMedia.clearRemoteVideos();
  for (const elements of [...audio.values(), ...screenAudio.values()]) {
    for (const element of elements) { element.pause(); element.srcObject = null; element.remove(); }
  }
  audio.clear();
  screenAudio.clear();
});
```

`onRemoteStream` (`rtc.ts:406`) e o estado `remoteVideos` do `App.tsx`
(`:1103`, `:1752-1772`) deixam de existir. Quem quer vídeo assina
`subscribeRemoteVideos`.

### 4.4 `App.tsx` — `VideoTile`

O componente passa a receber a `RemoteVideo` (ou um `MediaStream` local, para
a própria câmera e a própria tela) em vez de sempre um `MediaStream`:

```tsx
type TileMedia =
  | { kind: "remote"; video: RemoteVideo }
  | { kind: "local"; stream: MediaStream };

function VideoTile({ media, ... }: { media: TileMedia; ... }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;

    if (media.kind === "local") {
      element.srcObject = media.stream;
      void element.play().catch(() => {});
      return () => { element.srcObject = null; };
    }

    // Remoto: o SDK precisa conhecer ESTE elemento para o adaptiveStream
    // reportar visibilidade correta (RC-12).
    media.video.track.attach(element);
    return () => { media.video.track.detach(element); };
  }, [media.kind, media.kind === "remote" ? media.video.trackSid : media.stream]);

  const ready = useVideoReady(videoRef, media);
  // ... resto do render, inalterado ...
}
```

A dependência do `useEffect` precisa ser o `trackSid`, não o objeto `track`:
o SDK pode entregar a mesma instância de track em eventos diferentes, e
reanexar sem necessidade causa exatamente o flicker que SPEC-013 ataca.

`MiniVideo` (`App.tsx:502-517`), usado no preview de hover, recebe o mesmo
tratamento. Isso é o que faz o preview funcionar de verdade: hoje ele é um
`<video>` com `srcObject` que o SDK não conhece, então o SFU não envia frames
para ele.

`useVideoReady` (`App.tsx:465-487`) passa a receber `TileMedia` e obter a track
correspondente:

```ts
function useVideoReady(ref: RefObject<HTMLVideoElement | null>, media: TileMedia) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const video = ref.current;
    if (!video) { setReady(false); return; }
    const track = media.kind === "local"
      ? media.stream.getVideoTracks()[0] ?? null
      : media.video.track.mediaStreamTrack;
    // ... resto igual, com os mesmos listeners ...
  }, [ref, media]);
  return ready;
}
```

### 4.5 `tilesForParticipant` e `pickRemoteVideo`

`pickRemoteVideo` (`App.tsx:2664-2671`) é **removido**. Substituído por
`remoteMedia.findRemoteVideo(userId, source)`.

`tilesForParticipant` (`App.tsx:2679-2700`) passa a decidir a existência do
tile de tela pela presença de uma track de tela **no `voiceStore`** (para saber
que a pessoa está compartilhando, mesmo sem eu estar assistindo) e a existência
do vídeo pela presença em `remoteMedia` (para saber se estou recebendo):

```ts
function tilesForParticipant(participant: LiveParticipant): VoiceTileDesc[] {
  const isSelf = participant.isLocal;
  const cameraMedia: TileMedia | undefined = isSelf
    ? (selfCameraStream ? { kind: "local", stream: selfCameraStream } : undefined)
    : wrapRemote(remoteMedia.findRemoteVideo(participant.userId, "camera"));

  // A pessoa está compartilhando? Isso vem da projeção do servidor.
  const sharing = sessionTracks.some(t => t.owner === participant.userId && t.source === "screen_share");
  const screenMedia: TileMedia | undefined = isSelf
    ? (mySharingStreamId && localScreenStream ? { kind: "local", stream: localScreenStream } : undefined)
    : wrapRemote(remoteMedia.findRemoteVideo(participant.userId, "screen_share"));

  const tiles: VoiceTileDesc[] = [{ key: `cam:${participant.userId}`, kind: "cam", participant, media: cameraMedia }];
  if (isSelf ? !!mySharingStreamId : sharing) {
    tiles.push({ key: `screen:${participant.userId}`, kind: "screen", participant, media: screenMedia });
  }
  return tiles;
}
```

`sessionTracks` vem de `voiceStore.getState().rooms[channelId]?.tracks`, com o
canal da sessão.

O tile de tela sem `media` continua mostrando o placeholder com o botão
"Assistir transmissão" (`App.tsx:2711-2730`), que é o comportamento certo:
alguém está compartilhando e eu ainda não assinei.

### 4.6 Detecção de travamento (para provar ou refutar em produção)

Adicionar ao `remoteMedia` um monitor leve que emite `watch.stalled` quando uma
track assinada não produz frames:

```ts
/** Um vídeo assinado que não recebe frames por mais de 8 s é sintoma de
 *  RC-12 ou de problema de rede. Emitir o evento permite provar em produção
 *  (06-observability.md §3). */
function monitorStall(entry: RemoteVideo) {
  let lastFrames = 0;
  const timer = setInterval(async () => {
    const stats = await entry.track.getReceiverStats?.().catch(() => undefined);
    const frames = stats?.framesDecoded ?? 0;
    if (frames === lastFrames && frames >= 0) {
      logClient("watch.stalled", { owner: entry.ownerId, track_sid: entry.trackSid, seconds_without_frames: 8 });
    }
    lastFrames = frames;
  }, 8000);
  return () => clearInterval(timer);
}
```

`getReceiverStats` existe em `RemoteVideoTrack`
(`livekit-client.esm.mjs:15423`). Se o campo `framesDecoded` não estiver
disponível na estrutura devolvida, usar `track.mediaStreamTrack.muted` como
proxy: uma track remota `muted` por mais de 8 s enquanto o servidor a lista
como publicada é exatamente o sintoma. Implementar as duas checagens, com
`||`, para não depender de uma só.

E `watch.first_frame` no primeiro `playing` do elemento:

```ts
// dentro do useEffect de VideoTile, para media.kind === "remote":
const onPlaying = () => {
  logClient("watch.first_frame", {
    owner: media.video.ownerId,
    track_sid: media.video.trackSid,
    duration_ms: Date.now() - (watchRequestedAt.get(media.video.trackSid) ?? Date.now()),
  });
  element.removeEventListener("playing", onPlaying);
};
element.addEventListener("playing", onPlaying);
```

## 5. Contratos de dados

Nenhuma mudança de fio. Muda apenas como o cliente trata a mídia local.

## 6. Casos de borda a tratar

1. Duas instâncias do mesmo vídeo na tela (palco e preview de hover): o SDK
   aceita múltiplos `attach` da mesma track (`livekit-client.esm.mjs:15486`
   deduplica por elemento) e a visibilidade vira o OU de todos
   (`:15614`, `elementInfos.some(info => info.visible)`). Anexar nos dois é
   correto e desejado.
2. `detach` de um elemento nunca anexado: o SDK ignora; não tratar.
3. Componente desmontando enquanto a track é removida: o `useEffect` de cleanup
   e o `removeRemoteVideo` correm. O cleanup usa a referência capturada, então
   é seguro.
4. Track removida do registro mas ainda anexada: o `detach` do cleanup roda de
   qualquer forma quando o componente desmonta.
5. Elemento oculto por CSS do lado da UI (tile em aba não visível): agora o
   `adaptiveStream` **corretamente** para o envio, e ao reexibir ele volta.
   Isso é a funcionalidade, não um bug. Confirmar no roteiro M-02 passo 9.
6. Vídeo em fullscreen ou picture-in-picture: o SDK trata PiP explicitamente
   (`livekit-client.esm.mjs:15613`); nada a fazer.
7. `getReceiverStats` indisponível: o proxy por `muted` cobre.
8. Áudio de tela: continua no elemento escondido; `adaptiveStream` não gerencia
   áudio, então não há risco.

## 7. Critérios de aceite

- **Dado** que A compartilha tela e eu clico em assistir, **então** vejo frames
  em menos de 3 s, e um evento `watch.first_frame` é emitido.
- **Dado** que estou assistindo a uma tela e deixo a janela aberta por 5
  minutos, **então** o vídeo continua fluindo e nenhum `watch.stalled` é
  emitido.
- **Dado** que minimizo a janela do app por 30 s e restauro, **então** o vídeo
  volta em menos de 3 s.
- **Dado** que uma pessoa tem câmera **e** tela ligadas, **então** os dois
  tiles mostram o conteúdo correto (nada de câmera aparecendo como tela).
- **Dado** que saio da call, **então** nenhum elemento `<audio>` fica no
  `document.body` (verificável no DevTools).
- **Dado** um preview de hover, **então** ele mostra frames, não um retângulo
  preto permanente.

O quarto critério é o que valida a troca de `msid` por `publication.source`.

## 8. Como testar

### Automatizado — `client/ui/src/remoteMedia.test.ts`

| Teste | Cenário |
|---|---|
| `classifies_by_publication_source_not_msid` | duas tracks do mesmo dono, câmera e tela |
| `find_returns_undefined_when_not_subscribed` | |
| `clear_removes_everything_and_notifies` | |
| `remove_by_sid_leaves_the_other` | |

Teste de componente para o `attach`, com um duplo de `RemoteVideoTrack` que
registra chamadas de `attach` e `detach`:

| Teste | Cenário |
|---|---|
| `video_tile_attaches_the_visible_element` | `attach` recebe o elemento do ref |
| `video_tile_detaches_on_unmount` | |
| `video_tile_does_not_reattach_on_unrelated_rerender` | mesma `trackSid`, props diferentes |

O último protege contra o flicker.

### Manual

Roteiro M-02 completo (compartilhamento repetido, 5 ciclos, com minimizar e
restaurar no passo 9) e M-04 (preview "AO VIVO").

Verificação direta de RC-12, que vale fazer uma vez para confirmar a hipótese:

1. Antes da mudança, com A compartilhando e B assistindo, abrir o DevTools de B
   e rodar `await room.remoteParticipants.get(idDeA).videoTrackPublications.values().next().value.videoTrack.getReceiverStats()`.
   Anotar `framesDecoded`. Esperar 10 s e repetir. **Se o número parar de subir,
   RC-12 está confirmado.**
2. Depois da mudança, repetir. O número precisa subir continuamente.

Registrar os dois resultados no PR. Isso transforma a hipótese em fato
documentado.

## 9. Riscos e rollback

| Risco | Mitigação |
|---|---|
| `attach`/`detach` no ciclo de vida do React causa reanexos em excesso | Dependência do efeito é `trackSid`, não o objeto; teste dedicado |
| Um tile fora da viewport para de receber e o usuário estranha | É o comportamento correto do `adaptiveStream`; volta em menos de 3 s ao reexibir, coberto por M-02 passo 9 |
| `getReceiverStats` com forma diferente da esperada | Proxy por `muted` implementado em paralelo |
| Remover `onRemoteStream` quebra algum consumidor esquecido | `npm run build` (tsc) aponta todos |

**Rollback:** `git revert`. Volta ao comportamento atual, incluindo o bug.

## 10. Fora de escopo

- Não mudar a decisão de manter `adaptiveStream: true`
  (`09-alternatives-rejected.md` §1).
- Não mexer na publicação de tela (SPEC-010) nem no spectator (SPEC-011).
- Não memoizar componentes (SPEC-013).
- Não mudar o áudio remoto além de registrar a limpeza.
- Não mexer na captura nativa.
