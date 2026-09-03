# SPEC-011 — Ciclo de vida do spectator e do preview "AO VIVO"

## 1. Problema

**Causas raiz:** RC-08 (`spectate` sequestra a variável `active`, então
`leaveCall`, publicação e reanúncio agem sobre a sala errada), RC-17 (o preview
por hover e o botão "AO VIVO" disputam o mesmo mapa `wantedScreens`, causando
`setSubscribed(false)` seguido de `setSubscribed(true)` em milissegundos),
RC-07 (lado cliente: o espectador nunca desconecta, então fica listado).

`client/ui/src/rtc.ts:404`:

```ts
export async function spectate(id, sid, owner) {
  if (!active) { /* ... */ active = room; }   // sala de espectador vira "a call"
  watchStream(id, sid, owner);
}
export function stopSpectate(_: string) {}     // não faz nada
```

Com `active` apontando para uma sala com `canPublish: false`, qualquer tentativa
de publicar microfone, câmera ou tela falha. E como `stopSpectate` é vazia, a
conexão de espectador sobrevive até o app fechar, mantendo a pessoa dentro da
sala do LiveKit indefinidamente.

**Sintomas que desaparecem:** 4 (preview "ao vivo" bugado), 1 (pessoa aparece
em canal onde não está), 5 (erro ao entrar depois de ter espiado).

## 2. Prioridade e dependências

- **Prioridade:** P0
- **Dependências:** SPEC-007 (`callSession`), SPEC-009 (`remoteMedia`).

## 3. Arquivos afetados

| Arquivo | Ação |
|---|---|
| `client/ui/src/spectator.ts` | criar |
| `client/ui/src/rtc.ts` | editar: remover `spectate` / `stopSpectate`; `watchStream` fica só para a call |
| `client/ui/src/App.tsx` | editar: `peekEnter`, `peekLeave`, `endPeek`, `focusLiveShare`, `toggleWatch` |
| `client/ui/src/spectator.test.ts` | criar |

## 4. Mudança especificada

### 4.1 Separação de conceitos

Três coisas hoje confundidas, que passam a ser distintas:

| Conceito | Onde vive | Sala do LiveKit |
|---|---|---|
| **Assistir** uma tela de alguém do canal em que estou | `watchStream` no `rtc.ts` | a sala da call (`callSession.activeRoom()`) |
| **Espiar** (hover) uma tela de um canal em que **não** estou | `spectator.ts` | uma sala separada, token `mode: "spectator"` |
| **Espiar** uma tela de alguém do canal em que **estou** | `watchStream` | a sala da call |

O terceiro caso é o que hoje leva ao `setSubscribed` em pingue-pongue: espiar e
assistir são a mesma operação técnica na mesma sala, e precisam de um contador,
não de dois donos independentes.

### 4.2 `client/ui/src/spectator.ts` (novo)

```ts
/**
 * Sala de espectador: uma conexão LiveKit separada, só para ver a tela de
 * alguém em um canal em que NÃO estou.
 *
 * INV-D3: esta sala NUNCA é a sala da call. `callSession` e `spectator` têm
 * referências independentes, e nada publica aqui (o token vem com
 * canPublish: false e hidden: true — server/src/livekit.rs:201).
 */
import { Room, RoomEvent, Track } from "livekit-client";

type SpectatorSession = {
  id: number;
  channelId: string;
  ownerId: string;
  room: Room;
};

let current: SpectatorSession | null = null;
let nextId = 1;
let queue: Promise<unknown> = Promise.resolve();

/** Espia a tela de `ownerId` no canal `channelId`. Só uma por vez. */
export async function watch(channelId: string, ownerId: string): Promise<void>;

/** Encerra a sessão de espectador. Idempotente. */
export async function stop(): Promise<void>;

/** Quem estamos espiando agora, se alguém. */
export function watching(): { channelId: string; ownerId: string } | null;
```

Implementação, com as regras que importam:

```ts
export async function watch(channelId: string, ownerId: string): Promise<void> {
  return serialize(async () => {
    // Já espiando esta mesma pessoa: nada a fazer. Sem isto, mover o mouse
    // dentro da mesma linha reconectaria a sala (RC-17).
    if (current && current.channelId === channelId && current.ownerId === ownerId) return;

    await stopInternal();

    const id = nextId++;
    const credential = await mintCredentials(channelId, "spectator");
    if (!isCurrent(id)) return;

    const room = new Room({ adaptiveStream: true, dynacast: true });
    const session: SpectatorSession = { id, channelId, ownerId, room };
    current = session;

    bindSpectatorRoom(session);
    await room.connect(credential.url, credential.token);
    if (!isCurrent(id)) { await room.disconnect(); return; }

    // Assinar apenas a tela do dono alvo. Nada de áudio, nada de câmera:
    // é um preview visual.
    subscribeScreenOf(session, ownerId);
    logClient("spectate.started", { channel_id: channelId, owner: ownerId });
  });
}

export async function stop(): Promise<void> {
  return serialize(stopInternal);
}

async function stopInternal(): Promise<void> {
  const session = current;
  if (!session) return;
  current = null;
  try {
    session.room.removeAllListeners();
    remoteMedia.removeVideosFromRoom(session.id);
    await session.room.disconnect();
  } catch (error) {
    logClient("spectate.stop_failed", { reason: String(error) });
  }
  logClient("spectate.stopped", { channel_id: session.channelId, owner: session.ownerId });
}
```

`subscribeScreenOf` cobre o caso de a publicação ainda não ter chegado:

```ts
function subscribeScreenOf(session: SpectatorSession, ownerId: string) {
  const apply = () => {
    const participant = session.room.remoteParticipants.get(ownerId);
    if (!participant) return;
    for (const publication of participant.trackPublications.values()) {
      if (publication.source === Track.Source.ScreenShare) void publication.setSubscribed(true);
    }
  };
  session.room.on(RoomEvent.TrackPublished, (_publication, participant) => {
    if (participant.identity === ownerId) apply();
  });
  session.room.on(RoomEvent.ParticipantConnected, participant => {
    if (participant.identity === ownerId) apply();
  });
  apply();
}
```

`remoteMedia` (SPEC-009) precisa saber de qual sala veio cada vídeo, para que
`removeVideosFromRoom` funcione. Adicionar um campo `roomKey: string` em
`RemoteVideo` (`"call"` ou `"spectator:<id>"`) e o método correspondente. Sem
isso, encerrar a sessão de espectador deixaria vídeos mortos no registro.

### 4.3 `watchStream` com contagem de interesse (corrige RC-17)

Em `rtc.ts`, o mapa `wantedScreens` (`rtc.ts:56`) vira um contador por dono,
com duas origens declaradas:

```ts
/**
 * Quem queremos assistir, e por quais motivos. O preview por hover e o botão
 * "AO VIVO" são dois motivos independentes para a MESMA assinatura; sem o
 * contador, sair do hover cancelava a assinatura que o botão acabara de criar
 * (RC-17).
 */
type WatchReason = "hover" | "stage";
const watchIntent = new Map<string, Set<WatchReason>>();

export function watchStream(ownerId: string, reason: WatchReason): void {
  const reasons = watchIntent.get(ownerId) ?? new Set<WatchReason>();
  const hadAny = reasons.size > 0;
  reasons.add(reason);
  watchIntent.set(ownerId, reasons);
  if (!hadAny) applySubscription(ownerId, true);
}

export function stopWatchingStream(ownerId: string, reason: WatchReason): void {
  const reasons = watchIntent.get(ownerId);
  if (!reasons) return;
  reasons.delete(reason);
  if (reasons.size === 0) {
    watchIntent.delete(ownerId);
    applySubscription(ownerId, false);
  }
}

function applySubscription(ownerId: string, subscribed: boolean) {
  const room = callSession.activeRoom();
  const participant = room?.remoteParticipants.get(ownerId);
  if (!participant) return;
  for (const publication of participant.trackPublications.values()) {
    if (publication.source === Track.Source.ScreenShare) void publication.setSubscribed(subscribed);
  }
  if (subscribed) logClient("watch.requested", { owner: ownerId });
}
```

A assinatura das funções muda: some o `channelId` e o `sid`, que os chamadores
passavam e que não eram usados de forma confiável (`rtc.ts:394`, `:400`
ignoravam o `channelId` e usavam o `sid` só como chave de lookup com fallback).
Agora o alvo é o dono, e a publicação é resolvida por `source`, que é a fonte
correta (mesma decisão de SPEC-009).

`RoomEvent.TrackPublished` (`rtc.ts:177`) passa a consultar o contador:

```ts
room.on(RoomEvent.TrackPublished, (publication, participant) => {
  if (publication.source !== Track.Source.ScreenShare) return;
  if (watchIntent.has(participant.identity)) void publication.setSubscribed(true);
});
```

Isso é o que faz "a pessoa republica a tela e eu continuo vendo" funcionar: a
intenção sobrevive à troca de publicação (RC-03 do lado do espectador).

### 4.4 `App.tsx` — hover e "AO VIVO"

`peekEnter` (`App.tsx:2433-2443`):

```ts
function peekEnter(channelId: string, ownerId: string, isHere: boolean) {
  cancelPeekHide();
  if (peekOwner === ownerId) return;
  if (peekOwner && peekOwner !== ownerId) endPeek();
  setPreviewHot(false);
  peekMetaRef.current = { channelId, ownerId, spectator: !isHere };
  peekOwnerRef.current = ownerId;
  if (isHere) rtc.watchStream(ownerId, "hover");
  else void spectator.watch(channelId, ownerId);
  setPeekOwner(ownerId);
}
```

`endPeek` (`App.tsx:2422-2432`):

```ts
function endPeek() {
  const meta = peekMetaRef.current;
  if (meta) {
    if (meta.spectator) void spectator.stop();
    else rtc.stopWatchingStream(meta.ownerId, "hover");   // só o motivo "hover"
    peekMetaRef.current = null;
  }
  peekOwnerRef.current = null;
  setPeekOwner(null);
  setPreviewHot(false);
}
```

O `stopWatchingStream(ownerId, "hover")` só cancela a assinatura se não houver
`"stage"` ativo. É a correção direta de RC-17.

`peekLeave` (`App.tsx:2444-2451`) tem um bug de closure: lê `watching[ownerId]`
capturado no render. Com o contador em `rtc.ts`, a decisão sai da UI:

```ts
function peekLeave(ownerId: string) {
  cancelPeekHide();
  peekHideTimer.current = window.setTimeout(() => {
    peekHideTimer.current = null;
    if (peekOwnerRef.current === ownerId) endPeek();
    else setPreviewHot(false);
  }, 220);
}
```

`toggleWatch` (`App.tsx:2356-2366`):

```ts
function toggleWatch(ownerId: string) {
  if (!call) return;
  const isWatching = watching[ownerId] === true;
  if (isWatching) {
    rtc.stopWatchingStream(ownerId, "stage");
    setWatching(current => ({ ...current, [ownerId]: false }));
  } else {
    rtc.watchStream(ownerId, "stage");
    setWatching(current => ({ ...current, [ownerId]: true }));
  }
}
```

A heurística atual de "decidir pelo que está na tela"
(`App.tsx:2361-2362`, `const hasVideo = !!pickRemoteVideo(...)`) some. Ela
existia para contornar o estado preso quando a assinatura morria sem a UI
saber; com SPEC-009 e o contador, o estado não fica mais preso, e a heurística
passaria a atrapalhar (clicar em "Parar" quando o vídeo está carregando
resubscreveria em vez de parar).

`focusLiveShare` (`App.tsx:2374-2399`):

```ts
function focusLiveShare(channel: Channel, ownerId: string) {
  if (ownerId === currentUserId) return;
  cancelPeekHide();
  endPeek();                       // encerra o hover (e a sala de espectador)
  setFocusedUser(ownerId);
  setTheater(false);
  chooseVoiceChannel(channel);     // entra no canal, se não estiver
  if (call?.channelId === channel.id) {
    rtc.watchStream(ownerId, "stage");
    setWatching(current => ({ ...current, [ownerId]: true }));
  } else {
    pendingWatchRef.current = { ownerId };
  }
}
```

O `pendingWatchRef` (`App.tsx:1101`, aplicado em `:1740-1750`) continua, mas
simplifica: como `watchStream` agora só precisa do dono, o efeito não depende
mais de encontrar o `stream_id` na lista:

```ts
useEffect(() => {
  const pending = pendingWatchRef.current;
  if (!pending || !call) return;
  pendingWatchRef.current = null;
  rtc.watchStream(pending.ownerId, "stage");
  setWatching(current => ({ ...current, [pending.ownerId]: true }));
}, [call?.channelId]);
```

A dependência muda de `[streams, call, watching]` para `[call?.channelId]`:
o efeito só precisa rodar quando a call muda, e a assinatura é aplicada assim
que a publicação aparecer, pelo handler de `TrackPublished`.

### 4.5 Limpeza no teardown

`callSession` registra `spectator.stop()`? **Não.** A sala de espectador é
independente da call por definição (INV-D3): posso estar espiando um canal
enquanto entro em outro. O que precisa acontecer é:

- `spectator.stop()` quando o hover termina (`endPeek`);
- `spectator.stop()` quando a UI desmonta (efeito de unmount no `App.tsx`);
- `spectator.stop()` quando o app vai fechar (SPEC-012).

E `endPeek` já é chamado em `leaveCall` (`App.tsx:2200`), o que cobre o caso de
sair da call com um preview aberto.

## 5. Contratos de dados

Nenhuma mudança de fio. O token de espectador já existe
(`server/src/routes/livekit.rs:24`, `mode: "spectator"`), e SPEC-004 já garante
que ele não entra em roster nenhum (INV-B3).

## 6. Casos de borda a tratar

1. Hover em A, depois em B, sem sair da sidebar: `watch(canal, B)` chama
   `stopInternal` da sessão de A antes. Uma sessão por vez.
2. Hover no mesmo A duas vezes seguidas (mouse saindo e voltando dentro dos
   220 ms): `cancelPeekHide` cancela o timer; `watch` detecta que já é o mesmo
   alvo e não faz nada.
3. Hover em alguém do canal em que estou, e depois clicar em "AO VIVO":
   `hover` e `stage` coexistem; sair do hover não cancela.
4. Clicar em "AO VIVO" de um canal em que não estou: `endPeek` encerra a sala
   de espectador, `chooseVoiceChannel` entra no canal, e o `pendingWatchRef`
   aplica o `stage` quando a call sobe.
5. A pessoa para de compartilhar enquanto espio: o `TrackUnsubscribed` remove o
   vídeo do `remoteMedia`, o preview some, e a sala de espectador continua
   conectada até o hover terminar. Aceito: reconectar a cada republicação seria
   pior.
6. Falha ao obter credencial de espectador: `watch` rejeita; o `App.tsx` não
   mostra banner para preview (é uma ação passageira), apenas loga.
7. A sala de espectador cai (`Disconnected`): limpar `current` e os vídeos, sem
   reconectar. O usuário tira o mouse e coloca de novo se quiser.
8. Espiar a si mesmo: bloqueado na UI (`canPeek = !!share && !isSelf`,
   `App.tsx:3142`), mantido.
9. Espiar enquanto o app está desconectado do WS: `mintCredentials` falha por
   timeout; loga e não faz nada.

## 7. Critérios de aceite

- **Dado** que estou em uma call, **quando** passo o mouse sobre a linha de
  alguém de outro canal, **então** vejo o preview e **continuo** ouvindo e
  falando na minha call. **INV-D3.**
- **Dado** que espio alguém de outro canal, **então** meu nome **não** aparece
  na sidebar daquele canal para ninguém. **INV-B3.**
- **Dado** que espio e tiro o mouse, **então** a sala de espectador é
  desconectada em menos de 1 s.
- **Dado** que estou assistindo à tela de A no palco, **quando** passo o mouse
  sobre a linha de A e tiro, **então** continuo assistindo. **RC-17.**
- **Dado** que espio alguém de outro canal e clico em "AO VIVO", **então**
  entro no canal e vejo a tela no palco em menos de 5 s.
- **Dado** que espiei e depois entro em um canal qualquer, **então** consigo
  publicar microfone, câmera e tela normalmente. **RC-08.**
- **Dado** que A republica a tela enquanto assisto, **então** volto a ver em
  menos de 3 s, sem clicar em nada.

## 8. Como testar

### Automatizado — `client/ui/src/spectator.test.ts`

Testes U-30 e U-31 de `07-test-plan.md` §2, mais:

| Teste | Cenário |
|---|---|
| `watching_same_owner_twice_does_not_reconnect` | uma chamada de `connect` |
| `watching_another_owner_disconnects_the_previous` | ordem verificada |
| `stop_removes_videos_of_that_room_only` | vídeos da call permanecem |

E, em `rtc.test.ts` (novo, pequeno):

| Teste | Cenário |
|---|---|
| `hover_then_stage_keeps_subscription_when_hover_ends` | **o teste de RC-17** |
| `stage_only_unsubscribes_when_no_reason_remains` | |
| `track_published_reapplies_intent` | republicação |

### Manual

Roteiro M-04 completo (preview "AO VIVO"), com atenção ao passo 5 (o
espectador nunca aparece na sidebar) e ao passo 8 (funciona depois do ciclo).

Roteiro adicional, específico de RC-08:

1. Sem estar em canal nenhum, passar o mouse sobre alguém compartilhando.
2. Ver o preview.
3. Tirar o mouse.
4. Entrar em um canal de voz qualquer.
5. Falar. Os outros precisam ouvir.
6. Compartilhar a tela. Precisa funcionar.

Hoje o passo 5 e o 6 falham, porque `active` aponta para a sala de espectador
sem permissão de publicação.

## 9. Riscos e rollback

| Risco | Mitigação |
|---|---|
| Duas conexões LiveKit simultâneas por cliente (call e espectador) | Já é o caso hoje, só que com a segunda sequestrando a primeira; agora são explicitamente duas e a de espectador é curta |
| Custo no SFU de uma conexão a mais por hover | O espectador é `hidden` e assina uma track; o custo é o de um viewer, que é o que o hover é |
| Mudança de assinatura de `watchStream` quebra chamadores | `tsc` aponta; são 6 usos em `App.tsx` |
| `endPeek` chamado em cadeia (hover rápido entre linhas) | `serialize` na sala de espectador ordena; a UI é idempotente |

**Rollback:** `git revert`.

## 10. Fora de escopo

- Não mudar o visual do preview (`VoiceMemberPreview`, `App.tsx:523-564`).
- Não mudar a renderização (SPEC-009 já cobriu).
- Não permitir espiar áudio: o preview é visual, e assinar áudio de um canal em
  que não estou é uma mudança de produto, não de confiabilidade.
- Não mexer no publicador (SPEC-010).
