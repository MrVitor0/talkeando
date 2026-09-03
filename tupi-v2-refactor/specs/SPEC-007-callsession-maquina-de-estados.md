# SPEC-007 — `callSession`: máquina de estados de conexão de voz no cliente

## 1. Problema

**Causas raiz:** RC-09 ("client initiated disconnect" mostrado ao usuário),
RC-10 (join com falha parcial deixa recursos vivos e estado inconsistente),
A6 (token de 6 h nunca renovado), A7 (`AudioContext` vazado no erro de join).

`client/ui/src/rtc.ts` guarda o estado da call em cinco variáveis de módulo
soltas (`active`, `connecting`, `connectAttempt`, `presentChannelId`, `screen`,
`rtc.ts:11-20`) manipuladas por dez funções exportadas, sem nenhuma regra sobre
quem pode escrever o quê e quando. `joinCall` (`rtc.ts:273`) chama
`previous?.disconnect()` sem `await` (`:280`) e, no `catch` (`:315-321`), não
limpa `active` nem `presentChannelId`.

**Sintomas que desaparecem:** 5 ("não foi possível conectar o áudio: client
initiated disconnect"), parte de 1 (fantasma criado por join que falhou depois
de anunciar presença).

## 2. Prioridade e dependências

- **Prioridade:** P0
- **Dependências:** SPEC-005 (o servidor já aceita as dicas e não evicta por WS).
- **Dependência não bloqueante:** a decisão de TTL de §4.4 é implementada por
  SPEC-016. Esta spec funciona sem ela; o risco de token expirado só se
  materializa em calls de mais de 6 h.

Pode ser implementada antes de SPEC-008; as duas juntas formam o cliente v2,
mas esta sozinha já corrige o sintoma 5.

## 3. Arquivos afetados

| Arquivo | Ação |
|---|---|
| `client/ui/src/callSession.ts` | criar |
| `client/ui/src/rtc.ts` | editar: passa a delegar ciclo de vida ao `callSession` |
| `client/ui/src/App.tsx` | editar: `joinCall`, `leaveCall`, tratamento de erro |
| `client/ui/src/testing/fakeRoom.ts` | criar |
| `client/ui/src/callSession.test.ts` | criar |
| `client/ui/package.json` | nenhuma mudança (vitest já configurado) |

## 4. Mudança especificada

### 4.1 `client/ui/src/callSession.ts` (novo)

```ts
/**
 * Dono único do ciclo de vida de uma sessão de voz.
 *
 * Regra central (INV-C3): toda operação assíncrona carrega o `id` da sessão
 * que a originou. Um resultado que chega depois de a sessão ter sido
 * substituída é descartado sem efeito colateral — nada de estado global
 * escrito por um callback obsoleto.
 *
 * Regra de recursos (INV-D1): tudo que é criado é registrado em
 * `session.resources`, e `teardown` é o único lugar que destrói.
 */
import { Room, RoomEvent, DisconnectReason } from "livekit-client";

export type CallState = "idle" | "connecting" | "connected" | "reconnecting" | "tearing_down";

export type SessionSnapshot = {
  id: number;
  state: CallState;
  channelId: string | null;
  /** SID da nossa sessão no LiveKit; conhecido só depois de conectar. */
  participantSid: string | null;
};

type Disposer = () => void | Promise<void>;

type Session = {
  id: number;
  channelId: string;
  room: Room;
  state: CallState;
  /** Destruidores em ordem inversa de criação. */
  resources: Disposer[];
};
```

API pública:

```ts
/** Estado atual, para a UI. */
export function snapshot(): SessionSnapshot;

/** Assina mudanças de estado. Devolve o cancelador. */
export function onStateChange(listener: (snapshot: SessionSnapshot) => void): () => void;

/**
 * Entra em um canal. Sempre derruba a sessão anterior por completo antes de
 * criar a nova. Rejeita com um erro cujo `name` é "AbortError" quando esta
 * tentativa foi superada por outra — o chamador deve ignorar silenciosamente.
 */
export async function join(channelId: string, options: JoinOptions): Promise<void>;

/** Sai da call atual. Idempotente. */
export async function leave(): Promise<void>;

/** A sala ativa, ou null. Só o rtc.ts usa; a UI nunca toca no Room. */
export function activeRoom(): Room | null;

/** Registra um recurso para ser liberado no teardown desta sessão. */
export function registerResource(sessionId: number, dispose: Disposer): void;

/** True se `sessionId` ainda é a sessão corrente. Guard obrigatório em
 *  todo callback assíncrono. */
export function isCurrent(sessionId: number): boolean;

export type JoinOptions = {
  /** Busca credenciais; injetado para permitir teste sem IPC. */
  credentials: (channelId: string) => Promise<{ url: string; token: string }>;
  /** Roda depois de conectar, dentro do guard de sessão. Publicar o
   *  microfone, iniciar monitor de fala etc. acontecem aqui. */
  afterConnect: (room: Room, sessionId: number) => Promise<void>;
  /** Chamado quando a sessão termina por motivo NÃO solicitado por nós.
   *  Um teardown pedido pelo usuário não chama isto (INV-C4). */
  onUnexpectedEnd: (reason: EndReason) => void;
};

export type EndReason =
  | "server_shutdown"
  | "duplicate_identity"
  | "participant_removed"
  | "room_deleted"
  | "signal_close"
  | "unknown";
```

### 4.2 Implementação — as regras que não podem mudar

```ts
let current: Session | null = null;
let nextId = 1;
/** Ninguém observa: garante que join/leave nunca rodem concorrentes. */
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = queue.then(operation, operation);
  queue = next.then(() => undefined, () => undefined);
  return next;
}
```

Serializar `join` e `leave` na mesma fila é o que elimina a corrida de RC-09.
O padrão é idêntico ao que `AudioPipelineManager.enqueue` já usa
(`client/ui/src/audioPipeline.ts:189-193`), o que mantém uma convenção só no
código.

```ts
export async function join(channelId: string, options: JoinOptions): Promise<void> {
  return serialize(async () => {
    // 1. Derrubar a sessão anterior POR COMPLETO, com await.
    await teardownInternal("superseded");

    const id = nextId++;
    const room = new Room({ adaptiveStream: true, dynacast: true });
    const session: Session = { id, channelId, room, state: "connecting", resources: [] };
    current = session;
    emit();

    // O Room é o primeiro recurso registrado, então é o último a ser
    // destruído — depois das tracks que dependem dele.
    session.resources.push(async () => {
      room.removeAllListeners();
      await room.disconnect();
    });

    bindLifecycle(session, options);

    try {
      const credential = await options.credentials(channelId);
      if (!isCurrent(id)) throw superseded();
      await room.connect(credential.url, credential.token);
      if (!isCurrent(id)) throw superseded();

      session.state = "connected";
      session.participantSidCache = room.localParticipant.sid ?? null;
      emit();

      await options.afterConnect(room, id);
      if (!isCurrent(id)) throw superseded();
    } catch (error) {
      // Se já não somos a sessão corrente, outra `join` já fez (ou fará) o
      // teardown desta. Não mexer em nada.
      if (isCurrent(id)) {
        await teardownInternal("join_failed");
      }
      throw normalizeJoinError(error);
    }
  });
}
```

`normalizeJoinError` é o que mata o sintoma 5:

```ts
/**
 * Converte a rejeição do SDK em algo que a UI saiba classificar. Uma
 * conexão cancelada por nós mesmos vira AbortError e NUNCA vira banner
 * (INV-C4). O SDK rejeita com ConnectionError.cancelled('Client initiated
 * disconnect') quando disconnect() acontece durante o connect()
 * (livekit-client.esm.mjs:33609).
 */
function normalizeJoinError(error: unknown): Error {
  if (error instanceof Error && error.name === "AbortError") return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/client initiated disconnect/i.test(message)
      || /abort connection attempt/i.test(message)) {
    return superseded();
  }
  return error instanceof Error ? error : new Error(message);
}

function superseded(): Error {
  const error = new Error("Voice connection superseded by a newer request");
  error.name = "AbortError";
  return error;
}
```

Testar por mensagem é frágil em geral, mas aqui é a única discriminação
disponível: o SDK não expõe um código para essa rejeição específica. A
serialização de `join` já torna esse caminho raro; a normalização é a segunda
linha de defesa. O teste U-27 fixa o comportamento.

```ts
async function teardownInternal(trigger: TeardownTrigger): Promise<void> {
  const session = current;
  if (!session) return;
  current = null;              // ninguém mais é "corrente" a partir daqui
  session.state = "tearing_down";
  emit();

  // Ordem inversa de criação (INV-D1). Um erro em um destruidor não pode
  // impedir os demais de rodarem.
  for (const dispose of [...session.resources].reverse()) {
    try { await dispose(); }
    catch (error) { logClient("call.teardown.resource_failed", { trigger, reason: String(error) }); }
  }
  session.resources.length = 0;
  logClient("call.teardown", { channel_id: session.channelId, session_id: session.id, trigger });
  emit();
}

export async function leave(): Promise<void> {
  return serialize(() => teardownInternal("user_left"));
}
```

`bindLifecycle` traduz eventos do SDK, sempre com guard de sessão:

```ts
function bindLifecycle(session: Session, options: JoinOptions) {
  const { room, id } = session;

  room.on(RoomEvent.Reconnecting, () => {
    if (!isCurrent(id)) return;
    session.state = "reconnecting";
    emit();
    logClient("livekit.reconnecting", { channel_id: session.channelId });
  });

  room.on(RoomEvent.Reconnected, () => {
    if (!isCurrent(id)) return;
    session.state = "connected";
    emit();
    logClient("livekit.reconnected", { channel_id: session.channelId });
  });

  room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
    if (!isCurrent(id)) return;
    const mapped = mapDisconnectReason(reason);
    logClient("livekit.disconnected", { channel_id: session.channelId, reason: mapped ?? "client_initiated" });
    if (mapped === null) {
      // Fomos nós que pedimos. O teardown já está rodando ou vai rodar.
      return;
    }
    void serialize(async () => {
      if (!isCurrent(id)) return;
      await teardownInternal("livekit_disconnected");
      options.onUnexpectedEnd(mapped);
    });
  });
}

/** null = desconexão que nós pedimos; não é erro (INV-C4). */
function mapDisconnectReason(reason?: DisconnectReason): EndReason | null {
  switch (reason) {
    case DisconnectReason.CLIENT_INITIATED: return null;
    case DisconnectReason.DUPLICATE_IDENTITY: return "duplicate_identity";
    case DisconnectReason.SERVER_SHUTDOWN: return "server_shutdown";
    case DisconnectReason.PARTICIPANT_REMOVED: return "participant_removed";
    case DisconnectReason.ROOM_DELETED: return "room_deleted";
    case DisconnectReason.SIGNAL_CLOSE: return "signal_close";
    default: return "unknown";
  }
}
```

Os nomes do enum foram verificados em
`client/ui/node_modules/livekit-client/dist/livekit-client.esm.mjs:3927-3959`.
Importar `DisconnectReason` de `livekit-client`; ele é exportado.

### 4.3 `rtc.ts` passa a delegar

Trocar as variáveis de módulo `active`, `connecting`, `connectAttempt` e
`presentChannelId` por consultas ao `callSession`. As mudanças concretas:

```ts
// Remover: let active, connecting, connectAttempt, presentChannelId.
// Substituir todo uso de `active` por:
function room(): Room | null { return callSession.activeRoom(); }
function channelId(): string | null { return callSession.snapshot().channelId; }
```

`joinCall` (`rtc.ts:273-322`) vira:

```ts
export async function joinCall(id: string, isMuted: boolean, isDeafened: boolean) {
  locallyDeafened = isDeafened;
  localMuted = isMuted;
  wantedScreens.clear();
  await callSession.join(id, {
    credentials: channel => credentials(channel),
    afterConnect: async (room, sessionId) => {
      bindMedia(room, sessionId);       // o que hoje é `bind(room)`, menos ciclo de vida
      void room.startAudio().catch(() => {});

      // A dica de presença agora carrega o sid, o que dá saída imediata
      // ao sair (SPEC-005 §4.3).
      sendPresenceHint(id, "joining", room.localParticipant.sid ?? undefined);

      await microphone.start(
        { mode: noiseSuppressionMode, deviceId: audioInputDeviceId },
        async (track, pipeline) => {
          if (!callSession.isCurrent(sessionId)) return;
          await room.localParticipant.publishTrack(track, { source: Track.Source.Microphone });
          if (localMuted) {
            const publication = [...room.localParticipant.audioTrackPublications.values()]
              .find(item => item.source === Track.Source.Microphone);
            await publication?.track?.mute();
          }
        },
      );
      callSession.registerResource(sessionId, () => microphone.dispose());
      startLocalSpeechMonitor(room, sessionId);
    },
    onUnexpectedEnd: reason => {
      callEnded.forEach(listener => listener(reason));
    },
  });
}
```

`leaveCall` (`rtc.ts:323-335`) vira:

```ts
export async function leaveCall() {
  const channel = channelId();
  if (channel) sendPresenceHint(channel, "leaving", callSession.snapshot().participantSid ?? undefined);
  wantedScreens.clear();
  locallyDeafened = false;
  await callSession.leave();
}
```

`startLocalSpeechMonitor` (`rtc.ts:111-146`) passa a receber o `sessionId`,
registrar seu `AudioContext` e o `requestAnimationFrame` como recursos
(corrige A7), e trocar a checagem `active !== room` por
`!callSession.isCurrent(sessionId)`:

```ts
function startLocalSpeechMonitor(room: Room, sessionId: number) {
  stopLocalSpeechMonitor();
  // ... criação do contexto e do analyser, igual a hoje ...
  callSession.registerResource(sessionId, () => { stopLocalSpeechMonitor(); });
  const tick = () => {
    if (!callSession.isCurrent(sessionId) || localAnalyser !== analyser) return;
    // ... resto igual ...
  };
}
```

O elemento de mídia anexado em `TrackSubscribed` também vira recurso
registrado (corrige A8), mas isso é feito em SPEC-009, que reescreve essa
parte. Nesta spec, apenas registrar um destruidor que remove todos os
elementos remanescentes:

```ts
callSession.registerResource(sessionId, () => {
  for (const elements of [...audio.values(), ...screenAudio.values()]) {
    for (const element of elements) element.remove();
  }
  audio.clear();
  screenAudio.clear();
});
```

### 4.4 Renovação de token (corrige A6)

`livekit_token_ttl_seconds` é 21600 (6 h, `server/src/config.rs:374`). O SDK
usa o token original ao reconectar; depois de 6 h a reconexão falha com erro de
autenticação e a call morre sem recuperação.

**Decisão tomada: não renovar token em runtime; elevar o TTL para 24 h.**

O caminho de renovação em runtime foi investigado e descartado. O único método
do SDK 2.22.1 que aceita um token fora do `connect` é `prepareConnection`, e
ele retorna imediatamente quando a sala não está desconectada
(`livekit-client.esm.mjs:34561-34563`: `if (this.state !== ConnectionState.Disconnected) return;`).
Não há API pública para trocar o token de uma sessão conectada nessa versão.

Portanto:

1. Elevar `LIVEKIT_TOKEN_TTL_SECONDS` para `86400` (24 h) em
   `infra/docker-compose.production.yml`, no bloco de ambiente do
   `tupi-server`. A variável já é lida (`server/src/config.rs:374`) e hoje não
   é definida no compose, caindo no default de 21600.
2. Não implementar nenhum `setInterval` de renovação.

Justificativa: uma call contínua de mais de 24 h não é um caso de uso real
desta comunidade, e um mecanismo de renovação construído sobre um método que
não faz o que o nome sugere seria pior que o TTL generoso. Se no futuro o
requisito mudar, a solução correta é reconectar a sala com credencial nova
(um `join` completo), não remendar o token.

A mudança do compose pertence a SPEC-016, que é quem toca em `infra/`. Esta
spec apenas registra a decisão e a dependência.

### 4.5 `App.tsx`

`joinCall` (`App.tsx:2141-2186`): manter a estrutura, mudar o `catch`:

```ts
.catch(error => {
  if (error instanceof Error && error.name === "AbortError") return;   // INV-C4
  voiceConnTimers.current.forEach(id => window.clearTimeout(id));
  voiceConnTimers.current = [];
  setVoiceConnState("disconnected");
  setCall(current => current?.channelId === channel.id ? null : current);
  console.error("[ui] LiveKit voice connection failed", error);
  setError(`Não foi possível conectar o áudio: ${friendlyJoinError(error)}`);
});
```

`friendlyJoinError` mapeia os casos conhecidos para português, em vez de expor
`error.message` do SDK:

```ts
function friendlyJoinError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/token/i.test(message) && /timeout/i.test(message)) return "o servidor demorou para responder";
  if (/channel_full|já está cheio/i.test(message)) return "este canal já está cheio";
  if (/permission|NotAllowed/i.test(message)) return "o microfone não foi liberado";
  if (/network|ServerUnreachable|unreachable/i.test(message)) return "não foi possível alcançar o servidor de voz";
  return "erro de conexão";
}
```

`onCallDisconnected` (`App.tsx:1786-1799`) passa a receber a razão e só mostra
banner para razões que o usuário precisa saber:

```ts
useEffect(() => rtc.onCallDisconnected((reason: rtc.EndReason) => {
  callChannelIdRef.current = null;
  // ... todos os setState de limpeza, iguais a hoje ...
  const messages: Record<rtc.EndReason, string | null> = {
    server_shutdown: "O servidor de voz reiniciou. Entre novamente no canal.",
    duplicate_identity: "Sua conta entrou nesta call em outro dispositivo.",
    participant_removed: null,   // já há voice.disconnected com a mensagem certa
    room_deleted: null,
    signal_close: "A conexão de voz caiu. Entre novamente no canal.",
    unknown: "A conexão de voz foi encerrada. Entre novamente no canal.",
  };
  const message = messages[reason];
  if (message) setError(message);
}), []);
```

### 4.6 `client/ui/src/testing/fakeRoom.ts`

Um duplo mínimo do `Room` para os testes, sem a biblioteca real:

```ts
/** Duplo de Room suficiente para exercitar callSession sem WebRTC. */
export class FakeRoom {
  state: "new" | "connecting" | "connected" | "disconnected" = "new";
  localParticipant = { sid: "PA_fake", audioTrackPublications: new Map(), videoTrackPublications: new Map(), trackPublications: new Map(), publishTrack: vi.fn(), unpublishTrack: vi.fn() };
  remoteParticipants = new Map();
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  /** O teste controla quando (e se) o connect resolve. */
  connectBehavior: "resolve" | "reject" | "hang" = "resolve";
  on(event: string, handler: (...args: unknown[]) => void): this;
  removeAllListeners(): void;
  emit(event: string, ...args: unknown[]): void;
  async connect(url: string, token: string): Promise<void>;
  async disconnect(): Promise<void>;
  async startAudio(): Promise<void>;
}
```

`callSession` precisa aceitar uma fábrica de `Room` injetável para os testes:

```ts
let roomFactory: () => Room = () => new Room({ adaptiveStream: true, dynacast: true });
/** Apenas para testes. */
export function __setRoomFactory(factory: () => Room) { roomFactory = factory; }
```

## 5. Contratos de dados

`SessionSnapshot`, `JoinOptions` e `EndReason` são internos ao cliente. A
única mudança de fio é a dica de presença passar a carregar
`participant_sid`, definida em `05-protocol-spec.md` §3.1.

`sendPresenceHint` emite a op v2 quando o servidor anunciou
`voice.hints` em `features`, e a op v1 caso contrário:

```ts
function sendPresenceHint(channelId: string, state: "joining" | "leaving", participantSid?: string) {
  if (serverFeatures.has("voice.hints")) {
    send("voice.presence.hint", { channel_id: channelId, state, participant_sid: participantSid ?? null });
  } else {
    send(state === "joining" ? "voice.presence.enter" : "voice.presence.leave", { channel_id: channelId });
  }
}
```

`serverFeatures` vem do `auth.ok` e é populado em SPEC-008. Nesta spec, criar o
`Set` vazio em um módulo compartilhado (`client/ui/src/serverInfo.ts`) com um
`setServerInfo` chamado a partir do handler de `auth.ok`; enquanto SPEC-008 não
roda, o `Set` fica vazio e o caminho v1 é usado. Isso mantém a spec entregável
sozinha.

## 6. Casos de borda a tratar

1. `join` chamado enquanto outro `join` está em andamento: a fila serializa; o
   primeiro sofre teardown e sua promise rejeita com `AbortError`.
2. `join` chamado enquanto `leave` está em andamento: mesma fila, ordem
   preservada.
3. `leave` sem sessão: `teardownInternal` retorna imediatamente.
4. `connect()` que nunca resolve (rede morta): o SDK tem seu próprio timeout;
   além dele, `credentials` já tem timeout de 10 s (`rtc.ts:151`). Não adicionar
   um terceiro timeout.
5. `afterConnect` que lança depois de o microfone ter sido publicado: o
   teardown roda e despublica, porque o `microphone.dispose` foi registrado
   como recurso **antes** de `startLocalSpeechMonitor`.
6. Erro dentro de um destruidor: capturado e logado, os demais continuam.
7. `Disconnected` com `reason` indefinido: mapeado para `"unknown"`, que
   **mostra** banner. Um desconhecido merece aviso.
8. `Disconnected` chegando depois de o teardown já ter rodado: `isCurrent(id)`
   é falso, evento ignorado.
9. `DUPLICATE_IDENTITY` logo após um restart do app (RC-18): mensagem
   específica, não a genérica.
10. Renovação de token com o WebSocket caído: `credentials` rejeita por
    timeout; loga e tenta de novo no próximo intervalo.

## 7. Critérios de aceite

- **Dado** o usuário clicando em 5 canais em sequência rápida, **então** ele
  termina conectado no último, e **nenhum** banner de erro aparece. **INV-C4,
  sintoma 5.**
- **Dado** um `join` cuja aquisição de microfone falha, **então** o `Room` é
  desconectado, o `AudioContext` é fechado, `snapshot().channelId` volta a
  `null`, e uma dica de `leaving` **não** é enviada (nunca chegamos a anunciar
  presença com sucesso).
- **Dado** um `join` bem-sucedido seguido de `leave`, **então** todos os
  recursos registrados foram destruídos exatamente uma vez.
- **Dado** um `RoomEvent.Disconnected` com `CLIENT_INITIATED`, **então**
  `onUnexpectedEnd` **não** é chamado.
- **Dado** um `RoomEvent.Disconnected` com `SERVER_SHUTDOWN`, **então**
  `onUnexpectedEnd("server_shutdown")` é chamado exatamente uma vez.
- **Dado** um evento do SDK que chega depois do teardown, **então** nenhum
  estado global é alterado.
- **Dado** `leave` chamado duas vezes seguidas, **então** a segunda é no-op e
  não lança.

## 8. Como testar

### Automatizado — `client/ui/src/callSession.test.ts`

Testes U-24 a U-27 de `07-test-plan.md` §2, mais:

| Teste | Cenário |
|---|---|
| `join_serializes_and_last_one_wins` | 5 joins concorrentes; só o último fica |
| `teardown_runs_disposers_in_reverse_order` | ordem registrada e verificada |
| `disposer_error_does_not_stop_the_others` | um destruidor lança; os demais rodam |
| `late_disconnect_event_is_ignored` | emitir `Disconnected` no fake após teardown |
| `leave_is_idempotent` | duas chamadas seguidas |

### Manual

Roteiro M-05 (troca rápida de canal) de `07-test-plan.md` §5, com atenção
especial ao critério 4 (nenhum banner). Executar 5 vezes.

Complemento: com o app aberto, desligar o Wi-Fi por 30 s e religar (parte de
M-03). Verificar que a mensagem que aparece, se aparecer, é a de
`signal_close` e não a genérica.

## 9. Riscos e rollback

| Risco | Mitigação |
|---|---|
| A serialização introduz latência perceptível no join | O teardown de uma sessão idle é imediato; medir `call.join.connected` antes e depois |
| `normalizeJoinError` por regex quebra se o SDK mudar a mensagem | A serialização já torna esse caminho raro; teste U-27 fixa o comportamento atual |
| Call de mais de 24 h falha ao reconectar por token expirado | Decisão fechada em §4.4: TTL de 24 h via SPEC-016; não é caso de uso real |
| Refatorar `rtc.ts` quebra funcionalidades não relacionadas (câmera, volumes) | Essas funções passam a usar `room()` em vez de `active`, mudança mecânica; `npm run build` valida os tipos |

**Rollback:** `git revert` da spec. Como o servidor já aceita as ops v1, um
cliente revertido volta a funcionar como hoje.

## 10. Fora de escopo

- Não mudar de onde a UI tira a lista de participantes (SPEC-008).
- Não mexer em `adaptiveStream` nem na renderização de vídeo (SPEC-009).
- Não mudar o fluxo de publicação de tela (SPEC-010).
- Não mexer no spectator (SPEC-011).
- Não mudar `ClientProtocolVersion` para 2 (SPEC-008).
- Não tocar em chat, presença ou atividade.
