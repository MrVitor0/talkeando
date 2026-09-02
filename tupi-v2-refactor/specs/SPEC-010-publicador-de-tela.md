# SPEC-010 — Máquina de estados do publicador de tela

## 1. Problema

**Causas raiz:** RC-15 (`unpublishScreen` itera a coleção enquanto a modifica,
com `await` dentro do laço), RC-16 (estado global de captura reutilizado entre
sessões; áudio da captura anterior não é parado), RC-03 (lado cliente do
endereçamento por SID).

Sequência que quebra hoje, exatamente como o usuário relata: dar tela, parar,
dar de novo. Na segunda vez a track de áudio da primeira pode ter sobrevivido,
a captura nativa pode ainda estar entregando frames da fonte antiga
(`ScreenCapture.Stop` faz `_thread?.Join(800)`,
`client/native/Talkeando.Client/ScreenCapture.cs:249`), e o `stream_id`
inventado pela UI (`App.tsx:2266`) não tem relação com o `track_sid` real.

**Sintomas que desaparecem:** 4 (parar e começar de novo não funciona).

## 2. Prioridade e dependências

- **Prioridade:** P0
- **Dependências:** SPEC-007 (`callSession`), SPEC-009 (classificação por
  `publication.source`).

## 3. Arquivos afetados

| Arquivo | Ação |
|---|---|
| `client/ui/src/screenPublisher.ts` | criar |
| `client/ui/src/rtc.ts` | editar: `publishScreen` / `unpublishScreen` delegam |
| `client/ui/src/nativeScreen.ts` | editar: geração de captura, limpeza determinística |
| `client/ui/src/App.tsx` | editar: `shareSource`, `stopSharing`, estado de compartilhamento |
| `client/native/Talkeando.Client/IpcBridge.cs` | editar: parar áudio quando a nova captura não tem áudio |
| `client/ui/src/screenPublisher.test.ts` | criar |

## 4. Mudança especificada

### 4.1 `client/ui/src/screenPublisher.ts` (novo)

```ts
/**
 * Dono único do compartilhamento de tela local.
 *
 * Regra (INV-D2): iniciar e parar são serializados. Uma nova captura nunca
 * começa antes de a anterior ter terminado, e cada captura tem uma geração
 * própria — frames em voo da captura antiga são descartados.
 */

export type ShareState = "idle" | "starting" | "sharing" | "stopping";

export type ActiveShare = {
  /** Geração da captura nativa; incrementa a cada start. */
  generation: number;
  sourceId: string;
  height: number;
  fps: number;
  withAudio: boolean;
  /** SIDs das publicações no LiveKit; a fonte de verdade da identidade. */
  videoTrackSid: string | null;
  audioTrackSid: string | null;
  /** O MediaStream local, para o preview do próprio usuário. */
  stream: MediaStream;
};

export function state(): ShareState;
export function active(): ActiveShare | null;
export function onChange(listener: () => void): () => void;

export async function start(options: {
  sourceId: string;
  height: number;
  fps: number;
  withAudio: boolean;
}): Promise<ActiveShare>;

export async function stop(): Promise<void>;

/** Troca a fonte sem republicar: a captura nativa muda de alvo e o canvas
 *  continua o mesmo, então o sender do WebRTC não renegocia. */
export async function switchSource(sourceId: string): Promise<void>;

/** Muda resolução/fps da captura já ativa. */
export function reconfigure(height: number, fps: number): void;
```

Serialização, mesmo padrão de `callSession` e `AudioPipelineManager`:

```ts
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = queue.then(operation, operation);
  queue = next.then(() => undefined, () => undefined);
  return next;
}
```

### 4.2 `start` — ordem obrigatória

```ts
export async function start(options: StartOptions): Promise<ActiveShare> {
  return serialize(async () => {
    // 1. Nunca começar por cima de um compartilhamento vivo (INV-D2).
    await stopInternal("restart");

    const room = callSession.activeRoom();
    if (!room) throw new Error("não há call ativa");
    const sessionId = callSession.snapshot().id;

    current = { state: "starting" };
    emit();

    // 2. Captura nativa, com geração nova.
    const generation = nextGeneration++;
    const stream = startNativeScreen({
      generation,
      sourceId: options.sourceId,
      maxHeight: options.height,
      fps: options.fps,
      withAudio: options.withAudio,
    });

    logClient("screen.publish.started", {
      capture_generation: generation,
      source_id: options.sourceId,
      with_audio: options.withAudio,
    });

    try {
      // 3. Publicar VÍDEO primeiro, ÁUDIO depois. A ordem importa: o
      //    espectador precisa da imagem antes do som, e o teardown desfaz
      //    na ordem inversa.
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) throw new Error("a captura não produziu vídeo");
      const videoPublication = await room.localParticipant.publishTrack(videoTrack, {
        source: Track.Source.ScreenShare,
        simulcast: true,
      });
      if (!callSession.isCurrent(sessionId)) throw supersededError();

      let audioTrackSid: string | null = null;
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        const audioPublication = await room.localParticipant.publishTrack(audioTrack, {
          source: Track.Source.ScreenShareAudio,
          simulcast: false,
        });
        audioTrackSid = audioPublication?.trackSid ?? null;
        if (!callSession.isCurrent(sessionId)) throw supersededError();
      }

      const share: ActiveShare = {
        generation,
        sourceId: options.sourceId,
        height: options.height,
        fps: options.fps,
        withAudio: !!audioTrack,
        videoTrackSid: videoPublication?.trackSid ?? null,
        audioTrackSid,
        stream,
      };
      current = { state: "sharing", share };

      // 4. Só agora avisar o servidor, com os SIDs REAIS (RC-03).
      if (share.videoTrackSid) sendTrackHint(share.videoTrackSid, "screen_share", "published");
      if (share.audioTrackSid) sendTrackHint(share.audioTrackSid, "screen_share_audio", "published");

      // 5. O compartilhamento morre com a sessão (INV-D1).
      callSession.registerResource(sessionId, () => stopInternal("session_teardown"));

      logClient("screen.publish.published", {
        capture_generation: generation,
        track_sid: share.videoTrackSid,
      });
      emit();
      return share;
    } catch (error) {
      // Falha parcial: desfazer tudo, inclusive uma publicação que já
      // tenha ido ao ar.
      logClient("screen.publish.failed", {
        capture_generation: generation,
        reason: error instanceof Error ? error.message : String(error),
      });
      await stopInternal("publish_failed");
      throw error;
    }
  });
}
```

O ponto 4 é a correção central de RC-03 no cliente: hoje `App.tsx:2266` gera
`crypto.randomUUID()` como `streamId` e o passa adiante
(`App.tsx:2268-2269`), enquanto o `track_sid` real é reportado separadamente
(`rtc.ts:372`). Passa a existir **um** identificador: o do LiveKit.

### 4.3 `stopInternal` — ordem inversa e determinística

```ts
async function stopInternal(trigger: string): Promise<void> {
  const snapshot = current;
  if (snapshot.state === "idle") return;
  const share = snapshot.state === "sharing" ? snapshot.share : null;
  current = { state: "stopping" };
  emit();

  const room = callSession.activeRoom();

  // 1. Coletar ANTES de modificar (corrige RC-15: hoje o laço itera o Map
  //    enquanto unpublishTrack o modifica, com await no meio).
  const publications = room
    ? [...room.localParticipant.trackPublications.values()].filter(
        publication =>
          publication.source === Track.Source.ScreenShare ||
          publication.source === Track.Source.ScreenShareAudio,
      )
    : [];

  // 2. Áudio primeiro, vídeo depois: inverso da publicação.
  publications.sort((a, b) =>
    Number(b.source === Track.Source.ScreenShareAudio) - Number(a.source === Track.Source.ScreenShareAudio));

  for (const publication of publications) {
    const sid = publication.trackSid;
    const source = publication.source === Track.Source.ScreenShareAudio
      ? "screen_share_audio" : "screen_share";
    try {
      if (publication.track) await room!.localParticipant.unpublishTrack(publication.track, false);
    } catch (error) {
      logClient("screen.unpublish.failed", { track_sid: sid, reason: String(error) });
    }
    // Avisar o servidor mesmo se o unpublish falhou: o webhook é a autoridade,
    // e uma dica a mais é inofensiva.
    sendTrackHint(sid, source, "unpublished");
  }

  // 3. Parar a captura nativa e só então soltar as tracks locais.
  await stopNativeScreen(share?.generation);
  share?.stream.getTracks().forEach(track => track.stop());

  current = { state: "idle" };
  logClient("screen.unpublish.completed", { capture_generation: share?.generation ?? null, trigger });
  emit();
}
```

`unpublishTrack(track, false)` mantém o segundo parâmetro `stopOnUnpublish:
false`, como `rtc.ts:459` já faz para o microfone: quem para as tracks é o
publicador, não o SDK, para que a ordem seja controlada.

### 4.4 `nativeScreen.ts` — geração de captura

O módulo hoje guarda estado global (`active`, `canvas`, `ctx`, `audioWriter`,
`audioGenerator`, `audioFrameCount`) e `stopNativeScreen` é síncrono
(`nativeScreen.ts:167`). Mudanças:

```ts
/** Geração da captura corrente. Frames que chegam com geração diferente são
 *  descartados: o host nativo pode levar até 800 ms para parar a thread
 *  (ScreenCapture.cs:249) e, sem isto, frames da captura antiga são
 *  desenhados no canvas novo (RC-16). */
let captureGeneration = 0;

export function startNativeScreen(options: {
  generation: number;
  sourceId: string;
  maxHeight: number;
  fps: number;
  withAudio: boolean;
}): MediaStream {
  captureGeneration = options.generation;
  // ... criação de canvas, ctx e trilhas, como hoje ...
  send("screen.capture.start", {
    source_id: options.sourceId,
    max_height: options.maxHeight,
    max_fps: options.fps,
    audio: options.withAudio && !!audioTrack,
    generation: options.generation,
  });
  return new MediaStream(tracks);
}

/** Agora assíncrono: só resolve depois de o host confirmar a parada, ou após
 *  1 s de timeout. Isso é o que garante INV-D2. */
export async function stopNativeScreen(generation?: number): Promise<void> {
  if (generation !== undefined && generation !== captureGeneration) return;
  captureGeneration = 0;
  canvas = null;
  ctx = null;
  try { await audioWriter?.close(); } catch { /* já fechado */ }
  audioWriter = null;
  audioGenerator?.stop();
  audioGenerator = null;
  audioFrameCount = 0;
  audioPackets = 0;
  await requestCaptureStop();
}

/** Envia screen.capture.stop e espera screen.capture.stopped. */
function requestCaptureStop(): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(() => { off(); resolve(); }, 1000);
    const off = subscribe(event => {
      if (event.op !== "screen.capture.stopped") return;
      clearTimeout(timer); off(); resolve();
    });
    send("screen.capture.stop", {});
  });
}
```

E os handlers de frame passam a checar a geração:

```ts
webview?.addEventListener("message", (event: MessageEvent<unknown>) => {
  const envelope = event.data as { op?: string; data?: { slot: number; len: number; generation?: number } };
  if (!envelope?.data) return;
  // Descartar frames de uma captura anterior (RC-16).
  if (envelope.data.generation !== undefined && envelope.data.generation !== captureGeneration) return;
  if (envelope.op === "screen.frame") void onVideoFrame(envelope.data.slot, envelope.data.len);
  else if (envelope.op === "screen.audio") onAudioPacket(envelope.data.slot, envelope.data.len);
});
```

### 4.5 `IpcBridge.cs` — eco de geração e parada de áudio

Em `screen.capture.start` (`IpcBridge.cs:243-267`):

```csharp
case "screen.capture.start":
{
    var d = root.GetProperty("data");
    var sourceId = d.GetProperty("source_id").GetString() ?? "screen:all";
    var maxHeight = d.TryGetProperty("max_height", out var mh) ? mh.GetInt32() : 1080;
    var maxFps = d.TryGetProperty("max_fps", out var mf) ? mf.GetInt32() : 30;
    var withAudio = d.TryGetProperty("audio", out var au) && au.ValueKind == JsonValueKind.True;
    var generation = d.TryGetProperty("generation", out var gen) && gen.TryGetInt32(out var g) ? g : 0;
    _captureGeneration = generation;

    _screen.Start(sourceId, maxHeight, maxFps, jpeg =>
    {
        var slot = System.Threading.Interlocked.Increment(ref _frameSeq) & 1;
        WriteFrameSlot?.Invoke(jpeg, slot);
        Publish("screen.frame", new { slot, len = jpeg.Length, generation });
    });

    if (withAudio)
    {
        var (pid, mode) = ScreenCapture.ResolveAudioTarget(sourceId, BrowserProcessId);
        _audio.Start(pid, mode, pcm =>
        {
            var slot = (int)((uint)System.Threading.Interlocked.Increment(ref _audioSeq) % (uint)AudioSlotCount);
            WriteAudioSlot?.Invoke(pcm, slot);
            Publish("screen.audio", new { slot, len = pcm.Length, generation });
        });
    }
    else
    {
        // Hoje o áudio da captura anterior continua rodando quando a nova
        // não pede áudio (RC-16, item 2).
        _audio.Stop();
    }
    break;
}
```

Em `screen.capture.stop` (`IpcBridge.cs:268-271`), confirmar a parada:

```csharp
case "screen.capture.stop":
    _screen.Stop();
    _audio.Stop();
    _captureGeneration = 0;
    Publish("screen.capture.stopped", new { });
    break;
```

`ScreenCapture.Stop` e `AudioCapture.Stop` já fazem `Join(800)`
(`ScreenCapture.cs:249`, `AudioCapture.cs:164`), então o `screen.capture.stopped`
publicado depois deles significa "as threads terminaram", que é a garantia que
o `requestCaptureStop` espera.

### 4.6 `App.tsx`

`shareSource` (`App.tsx:2257-2276`):

```ts
async function shareSource(sourceId: string, options: ShareOptions) {
  setPickerOpen(false);
  if (!call) return;
  if (pickerSourceOnly && screenPublisher.active()) {
    await screenPublisher.switchSource(sourceId);
    return;
  }
  try {
    await screenPublisher.start({
      sourceId,
      height: options.height,
      fps: options.fps,
      withAudio: options.withAudio,
    });
    setShareQuality({ height: options.height, fps: options.fps });
    playSound("startScreen");
  } catch (error) {
    console.error("[ui] publishScreen failed", error);
    setError("Não foi possível iniciar o compartilhamento de tela.");
  }
}
```

`mySharingStreamId` (`App.tsx:1062`) deixa de existir; a UI passa a derivar de
`screenPublisher.active()` via `useSyncExternalStore(screenPublisher.onChange,
screenPublisher.active)`.

`stopSharing` (`App.tsx:2314-2320`):

```ts
async function stopSharing() {
  closeShareMenu();
  if (!screenPublisher.active()) return;
  playSound("stopScreen");
  await screenPublisher.stop();
}
```

`getLocalScreenStream` (`rtc.ts:385`) some; o preview próprio usa
`screenPublisher.active()?.stream`.

## 5. Contratos de dados

IPC (`protocol/ipc-envelope.schema.json` continua válido; os campos são livres
dentro de `data`):

| op | Direção | Campos novos |
|---|---|---|
| `screen.capture.start` | UI para nativo | `generation: number` |
| `screen.frame` | nativo para UI | `generation: number` |
| `screen.audio` | nativo para UI | `generation: number` |
| `screen.capture.stopped` | nativo para UI | (novo op, sem campos) |

Compatibilidade: a UI trata `generation` ausente como "aceitar" (para o caso de
um nativo antigo com UI nova, que não deve acontecer porque ambos vêm no mesmo
instalador, mas custa uma linha). O nativo antigo não publica
`screen.capture.stopped`, e o timeout de 1 s cobre.

Fio para o servidor: `voice.track.hint` com o `track_sid` real
(`05-protocol-spec.md` §3.2).

## 6. Casos de borda a tratar

1. `start` chamado com um compartilhamento ativo: `stopInternal("restart")`
   roda primeiro, com `await`. É o caso de "trocar de tela" pelo picker
   completo.
2. `start` que falha ao publicar o vídeo: `stopInternal` desfaz e a captura
   nativa para.
3. `start` que publica vídeo e falha no áudio: o vídeo publicado é despublicado
   por `stopInternal`. Compartilhar sem som não é oferecido como
   fallback silencioso: o usuário pediu com áudio, e um compartilhamento
   parcialmente publicado é pior que uma falha explícita.
4. `stop` sem compartilhamento: no-op.
5. Sessão de call terminando com compartilhamento ativo: o recurso registrado
   em `callSession` chama `stopInternal`.
6. `switchSource` com o publicador parado: no-op com log.
7. Fonte que desaparece (janela fechada): `ScreenCapture` cai para GDI ou
   encerra (`ScreenCapture.cs:236-239`); o canvas para de receber frames e o
   `<video>` congela. Detectar por `watch.stalled` no lado dos espectadores;
   do lado do publicador, nada a fazer nesta spec.
8. Dois `stop` concorrentes: a fila serializa; o segundo vê `idle`.
9. `generation` estourando: `number` em JS aguenta 2^53; irrelevante.
10. Frames chegando entre `stopNativeScreen` e a confirmação do host: `active`
    já é `false` e a geração já é 0, então são descartados duas vezes.

## 7. Critérios de aceite

- **Dado** que compartilho, paro e compartilho de novo cinco vezes seguidas,
  **então** em todas as cinco os espectadores conseguem assistir. **Sintoma 4.**
- **Dado** que compartilho com áudio e depois compartilho outra fonte sem
  áudio, **então** nenhuma captura WASAPI continua rodando (verificável pelo
  log do nativo).
- **Dado** que paro de compartilhar, **então** o `voice.track.hint
  unpublished` é enviado com o `track_sid` real, e o roster de todos perde o
  indicador em menos de 2 s.
- **Dado** que a publicação do áudio falha, **então** o vídeo também é
  despublicado e o usuário vê a mensagem de erro.
- **Dado** que saio da call enquanto compartilho, **então** a captura nativa
  para (a thread de captura encerra).
- **Dado** um `screen.frame` de uma geração antiga, **então** ele não é
  desenhado.
- **Dado** que troco a fonte pelo menu "Alterar tela", **então** os
  espectadores continuam assistindo sem precisar clicar de novo.

O último critério é importante: `switchSource` não republica, então a
assinatura do espectador é preservada.

## 8. Como testar

### Automatizado — `client/ui/src/screenPublisher.test.ts`

Testes U-28 e U-29 de `07-test-plan.md` §2, mais:

| Teste | Cenário |
|---|---|
| `start_while_sharing_stops_the_previous_first` | ordem de chamadas verificada |
| `failed_audio_publish_unpublishes_video` | |
| `hints_use_real_track_sids` | o `send` recebe o sid do fake, não um UUID |
| `session_teardown_stops_capture` | o recurso registrado é chamado |
| `frames_from_old_generation_are_dropped` | teste de `nativeScreen` com duplo de `webview` |

### Manual

Roteiro M-02 completo. Passos extras de verificação:

1. Compartilhar com áudio, parar, compartilhar sem áudio. No log do nativo
   (`DebugLog`), confirmar que `AudioCapture.Stop` foi chamado.
2. Compartilhar, e enquanto compartilha, sair da call pelo botão de
   desconectar. Confirmar no Gerenciador de Tarefas que o uso de CPU do Tupi
   volta ao normal (a thread de captura encerrou).
3. Compartilhar a janela de um jogo, fechar o jogo, e confirmar que o app não
   trava nem crasheia.

## 9. Riscos e rollback

| Risco | Mitigação |
|---|---|
| `stopNativeScreen` assíncrono atrasa o `stop` percebido | Timeout de 1 s; na prática o `Join(800)` do nativo resolve antes |
| A mudança no IPC exige nativo e UI na mesma versão | Ambos vêm no mesmo instalador; a UI tolera `generation` ausente |
| Publicar vídeo e áudio em sequência aumenta o tempo até o espectador ver | O vídeo vai primeiro; o espectador vê imagem antes do som, que é o certo |
| Remover `mySharingStreamId` toca muitos pontos do `App.tsx` | `tsc` aponta todos; são cerca de 10 usos |

**Rollback:** `git revert`. O servidor aceita as dicas antigas
(`05-protocol-spec.md` §6), então um cliente revertido funciona.

## 10. Fora de escopo

- Não mudar a captura GDI/WGC em si (`ScreenCapture.cs`, `WgcCapture.cs`).
- Não mudar o `ScreenPicker` nem os presets de qualidade.
- Não mexer no lado de quem assiste (SPEC-009 e SPEC-011).
- Não mudar a câmera (fluxo separado e hoje sem defeito relatado; ele passa a
  usar `publication.source` por SPEC-009 e isso basta).
- Não tocar no áudio do microfone nem no RNNoise.
