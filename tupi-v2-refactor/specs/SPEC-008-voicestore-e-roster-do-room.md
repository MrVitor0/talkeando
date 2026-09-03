# SPEC-008 — `voiceStore` e roster da própria call derivado do `Room`

## 1. Problema

**Causas raiz:** RC-02 (a UI monta a lista de participantes do roster do
servidor, não do `Room`), RC-19 (listener de WS recriado a cada troca de canal,
com janela sem listener), RC-11 (parte: re-render global por evento de roster),
RC-01 (o lado cliente da convergência).

`App.tsx:1380-1383` define `call` a partir de `voice.roster`. A lista exibida e
a lista de quem realmente é ouvido (`room.remoteParticipants`) são calculadas
por caminhos independentes. É por isso que "eu saio, elas somem da UI, mas eu
ainda ouço" é possível.

Além disso, o `useEffect` que assina eventos (`App.tsx:1251`) tem dependência
`[activeChannel?.id]`: a cada troca de canal ele é destruído e recriado, e
eventos entregues no intervalo se perdem.

**Sintomas que desaparecem:** 1 (o principal, e de forma estrutural), 2, parte
de 3.

## 2. Prioridade e dependências

- **Prioridade:** P0
- **Dependências:** SPEC-005 (servidor emite v2), SPEC-007 (`callSession`).

## 3. Arquivos afetados

| Arquivo | Ação |
|---|---|
| `client/ui/src/voiceStore.ts` | criar |
| `client/ui/src/serverInfo.ts` | criar |
| `client/ui/src/rtc.ts` | editar: expor eventos de participante do `Room` |
| `client/ui/src/App.tsx` | editar: consumir o store; remover estado de voz local |
| `client/ui/src/voiceStore.test.ts` | criar |
| `client/native/Talkeando.Client/NetworkClient.cs` | editar: `ClientProtocolVersion = 2` |

## 4. Mudança especificada

### 4.1 `client/ui/src/serverInfo.ts` (novo)

```ts
/** O que o servidor declarou no auth.ok (SPEC-001). Módulo, não estado React:
 *  é lido por rtc.ts e voiceStore.ts, que não são componentes. */
export type ServerInfo = {
  protocolVersion: number;
  serverVersion: string;
  features: Set<string>;
};

let info: ServerInfo = { protocolVersion: 1, serverVersion: "unknown", features: new Set() };

export function setServerInfo(next: {
  protocol_version?: number;
  server_version?: string;
  features?: string[];
}) {
  info = {
    protocolVersion: next.protocol_version ?? 1,
    serverVersion: next.server_version ?? "unknown",
    features: new Set(next.features ?? []),
  };
}

export function serverInfo(): ServerInfo { return info; }
export function hasFeature(name: string): boolean { return info.features.has(name); }
```

O `auth.ok` é relayado pelo nativo para a UI (`IpcBridge.cs:423` relaya tudo),
então basta a UI tratar o op.

### 4.2 `client/ui/src/voiceStore.ts` (novo)

```ts
/**
 * Estado de voz fora do React.
 *
 * Duas fontes, deliberadamente diferentes
 * (tupi-v2-refactor/03-target-architecture.md §1):
 *
 *   - `rooms`: canais em que NÃO estou. Projeção do servidor
 *     (voice.room.state / voice.room.delta). Pode estar atrasada; a versão
 *     por canal torna a perda detectável (INV-C2).
 *
 *   - `session`: o canal em que ESTOU. Derivado de room.remoteParticipants do
 *     LiveKit, com mute/deafen sobrepostos da projeção do servidor. É a mesma
 *     estrutura de onde sai o áudio, então é impossível ver um fantasma
 *     (INV-C1).
 */
import { hasFeature } from "./serverInfo";
import { send, subscribe } from "./ipc";

export type TrackSource = "microphone" | "camera" | "screen_share" | "screen_share_audio" | "music";

export type RosterParticipant = {
  userId: string;
  participantSid: string | null;
  muted: boolean;
  deafened: boolean;
  isBot: boolean;
  provisional: boolean;
};

export type RosterTrack = {
  trackSid: string;
  owner: string;
  source: TrackSource;
  muted: boolean;
};

export type RoomProjection = {
  channelId: string;
  version: number;
  participants: RosterParticipant[];
  tracks: RosterTrack[];
};

/** Alguém que estou realmente ouvindo agora, vindo do LiveKit. */
export type LiveParticipant = {
  userId: string;
  participantSid: string;
  isLocal: boolean;
  /** Overlay do servidor; false enquanto o servidor não disser o contrário. */
  muted: boolean;
  deafened: boolean;
  isBot: boolean;
};

export type VoiceState = {
  /** Canais em que não estou. Chave: channelId. */
  rooms: Record<string, RoomProjection>;
  /** O canal em que estou, ou null. */
  session: {
    channelId: string | null;
    participants: LiveParticipant[];
  };
};
```

API:

```ts
export function getState(): VoiceState;
export function subscribeVoice(listener: (state: VoiceState) => void): () => void;

/** Chamado uma única vez no boot da UI. Idempotente. */
export function initVoiceStore(): void;

/** rtc.ts avisa o store quando o Room muda de participantes. */
export function setLiveParticipants(channelId: string, participants: Array<{ identity: string; sid: string; isLocal: boolean }>): void;
export function clearSession(): void;
```

### 4.3 Aplicação de snapshot e delta

```ts
/** Canais aguardando snapshot por lacuna de versão; deltas deles são
 *  ignorados até o snapshot chegar (protocolo §2.2). */
const awaitingSnapshot = new Set<string>();

function applyState(payload: { full: boolean; rooms: RoomWire[] }) {
  const rooms: Record<string, RoomProjection> = {};
  for (const room of payload.rooms) rooms[room.channel_id] = toProjection(room);
  state = { ...state, rooms };
  for (const id of Object.keys(rooms)) awaitingSnapshot.delete(id);
  emit();
}

function applyDelta(delta: DeltaWire) {
  const channelId = delta.channel_id;
  if (awaitingSnapshot.has(channelId)) return;

  const local = state.rooms[channelId];
  if (!local) {
    // Nunca vimos este canal: peça o estado dele.
    requestSnapshot([channelId], "unknown_channel");
    return;
  }
  if (delta.previous_version === local.version) {
    state = { ...state, rooms: { ...state.rooms, [channelId]: applyOne(local, delta) } };
    emit();
    return;
  }
  if (delta.version <= local.version) return;                 // reentrega
  // Lacuna: perdemos pelo menos um delta.
  logClient("voice.version_gap", {
    channel_id: channelId,
    local_version: local.version,
    received_previous: delta.previous_version,
    received_version: delta.version,
  });
  requestSnapshot([channelId], "version_gap");
}
```

Ordem de aplicação dentro de um delta, exatamente como o protocolo manda
(§2.2), porque cliente e servidor precisam concordar:

```ts
function applyOne(room: RoomProjection, delta: DeltaWire): RoomProjection {
  let participants = room.participants;
  let tracks = room.tracks;

  // 1. participants_removed
  if (delta.participants_removed.length) {
    const removed = new Set(delta.participants_removed);
    participants = participants.filter(p => !removed.has(p.userId));
  }
  // 2. tracks_removed
  if (delta.tracks_removed.length) {
    const removed = new Set(delta.tracks_removed);
    tracks = tracks.filter(t => !removed.has(t.trackSid));
  }
  // 3. participants_added
  for (const wire of delta.participants_added) {
    const entry = toParticipant(wire);
    participants = [...participants.filter(p => p.userId !== entry.userId), entry];
  }
  // 4. participants_updated
  for (const wire of delta.participants_updated) {
    const entry = toParticipant(wire);
    participants = participants.map(p => (p.userId === entry.userId ? entry : p));
  }
  // 5. tracks_added
  for (const wire of delta.tracks_added) {
    const entry = toTrack(wire);
    tracks = [...tracks.filter(t => t.trackSid !== entry.trackSid), entry];
  }

  participants.sort((a, b) => a.userId.localeCompare(b.userId));
  tracks.sort((a, b) => a.trackSid.localeCompare(b.trackSid));
  return { channelId: room.channelId, version: delta.version, participants, tracks };
}
```

**A armadilha do restart do servidor** (protocolo §2.1): quando o processo
reinicia, `version` recomeça em 1. O `applyState` acima **substitui** o mapa
inteiro, então um snapshot com versões menores é aceito naturalmente. É por
isso que `applyState` não faz merge: fazer merge exigiria comparar versões e
cairia na armadilha. Um snapshot é sempre a verdade.

`requestSnapshot` com rate limit local, para não brigar com o do servidor:

```ts
let lastRequestAt = 0;
function requestSnapshot(channelIds: string[], reason: string) {
  for (const id of channelIds) awaitingSnapshot.add(id);
  const now = Date.now();
  if (now - lastRequestAt < 2000) return;    // o pedido pendente cobre
  lastRequestAt = now;
  if (hasFeature("voice.room.v2")) send("voice.room.request", { channel_ids: channelIds });
  else send("voice.rooms.request", {});
  logClient("voice.snapshot_requested", { reason, channels: channelIds.length });
}
```

### 4.4 Compatibilidade com servidor v1

Se `hasFeature("voice.room.v2")` é falso, o store consome `voice.rooms` e
`voice.roster` e os converte para a mesma forma interna, com
`version` sempre `0` e nenhuma detecção de lacuna:

```ts
function applyV1Rooms(payload: { rooms: V1RoomWire[] }) {
  const rooms: Record<string, RoomProjection> = {};
  for (const room of payload.rooms) rooms[room.channel_id] = fromV1(room);
  state = { ...state, rooms };
  emit();
}

function applyV1Roster(payload: V1RoomWire) {
  const projection = fromV1(payload);
  const rooms = { ...state.rooms };
  if (projection.participants.length === 0) delete rooms[payload.channel_id];
  else rooms[payload.channel_id] = projection;
  state = { ...state, rooms };
  emit();
}
```

`fromV1` converte `streams[]` v1 em `tracks[]`: um stream `kind: "screen"` com
`msid` vira uma `RosterTrack` com `source: "screen_share"` e
`trackSid: msid`; `has_audio: true` adiciona uma segunda com
`source: "screen_share_audio"` e `trackSid: msid + ":audio"` (sintético, só
para a UI saber que há áudio). `kind: "camera"` vira `source: "camera"`.
`kind: "music"` vira `source: "music"`.

Isso mantém **um único** formato interno na UI, independentemente do dialeto,
que é o que impede a UI de ter dois caminhos de render.

### 4.5 A sessão vem do `Room` (INV-C1)

`rtc.ts` passa a observar participantes e informar o store:

```ts
// Em bindMedia(room, sessionId), adicionar:
const syncParticipants = () => {
  if (!callSession.isCurrent(sessionId)) return;
  const channel = callSession.snapshot().channelId;
  if (!channel) return;
  const list = [
    {
      identity: room.localParticipant.identity,
      sid: room.localParticipant.sid ?? "",
      isLocal: true,
    },
    ...[...room.remoteParticipants.values()].map(p => ({
      identity: p.identity,
      sid: p.sid,
      isLocal: false,
    })),
  ];
  voiceStore.setLiveParticipants(channel, list);
};

room.on(RoomEvent.ParticipantConnected, syncParticipants);
room.on(RoomEvent.ParticipantDisconnected, syncParticipants);
room.on(RoomEvent.Reconnected, syncParticipants);
room.on(RoomEvent.ConnectionStateChanged, syncParticipants);
syncParticipants();   // estado inicial
```

`RoomEvent.ParticipantConnected` e `ParticipantDisconnected` existem no SDK
(`livekit-client.esm.mjs:12492` e `:12499`), assim como
`ConnectionStateChanged` (`:12471`) e `Reconnected` (`:12453`).

E `callSession` chama `voiceStore.clearSession()` no teardown, registrando-o
como recurso.

No store:

```ts
export function setLiveParticipants(channelId: string, live: Array<{ identity: string; sid: string; isLocal: boolean }>) {
  const projection = state.rooms[channelId];
  const participants: LiveParticipant[] = live.map(entry => {
    // Overlay do servidor: mute/deafen/bot. Ausência = valores neutros.
    const overlay = projection?.participants.find(p => p.userId === entry.identity);
    return {
      userId: entry.identity,
      participantSid: entry.sid,
      isLocal: entry.isLocal,
      muted: overlay?.muted ?? false,
      deafened: overlay?.deafened ?? false,
      isBot: overlay?.isBot ?? entry.identity === MUSIC_BOT_ID,
    };
  });
  participants.sort((a, b) => a.userId.localeCompare(b.userId));
  state = { ...state, session: { channelId, participants } };
  emit();
}
```

O ponto decisivo: `participants` vem **só** de `live`, que é
`room.remoteParticipants` mais o local. A projeção do servidor entra
exclusivamente como overlay de metadados. Se o servidor achar que há alguém que
o LiveKit não tem, essa pessoa **não aparece**. Se o LiveKit tiver alguém que o
servidor não conhece, essa pessoa **aparece**, sem mute/deafen até o servidor
alcançar.

Quando um delta atualiza mute/deafen de alguém da sessão, `emit` precisa
recalcular o overlay. Fazer isso dentro de `emit`, derivando a sessão a partir
do último `live` guardado:

```ts
let lastLive: { channelId: string; entries: LiveEntry[] } | null = null;
// applyDelta / applyState chamam recomputeSession() antes de emit().
```

### 4.6 `App.tsx`

Remover os `useState` de `voiceRooms` (`:1055`), `voiceRoomStreams` (`:1058`),
`call` (`:1049`) e `streams` (`:1061`). Substituir por um único hook:

```ts
function useVoiceState(): VoiceState {
  return useSyncExternalStore(subscribeVoice, getState, getState);
}
```

`useSyncExternalStore` é a API do React exatamente para isto e evita o padrão
`useState` mais `useEffect`, que causa um render extra por evento. A versão
instalada é React 19.2.8 (`client/ui/package-lock.json:2287`), que tem o hook.

Derivar o que a UI usa hoje:

```ts
const voice = useVoiceState();
const call = voice.session.channelId
  ? { channelId: voice.session.channelId, participants: voice.session.participants }
  : null;
const voiceRooms = useMemo(() =>
  Object.fromEntries(Object.entries(voice.rooms).map(([id, room]) => [id, room.participants])),
  [voice.rooms]);
```

Remover os handlers de `voice.rooms` e `voice.roster` do `useEffect` gigante
(`App.tsx:1359-1388`), que agora vivem no store. Manter no `useEffect` apenas
o que é de chat, presença, atividade e update.

E, crucialmente, **trocar a dependência do `useEffect` de assinatura**:

```ts
// Antes: }, [activeChannel?.id]);
// Depois: }, []);
```

Para isso, o handler não pode mais capturar `activeChannel` do closure. Os dois
usos são: `chat.history` (`:1402`) e `chat.message.created` (`:1436`, `:1460`).
Substituir por um ref já existente ou novo:

```ts
const activeChannelRef = useRef<Channel | null>(null);
useEffect(() => { activeChannelRef.current = activeChannel; }, [activeChannel]);
```

e ler `activeChannelRef.current` dentro do handler. Isso elimina RC-19: um
único listener, montado uma vez, sem janela cega.

O mesmo vale para `voice.moved` (`:1348`), que chama `joinCall(dest)` do
closure: passar a usar um ref para a função, ou mover a chamada para um efeito
que reage a um estado `pendingMove`.

### 4.7 `ClientProtocolVersion = 2`

`client/native/Talkeando.Client/NetworkClient.cs`: mudar a constante de
SPEC-001 de `1` para `2`. Esta é a spec em que o cliente passa a entender o
dialeto v2, então é aqui que ele pode anunciá-lo.

## 5. Contratos de dados

Wire: `05-protocol-spec.md` §2. Interno: os tipos de §4.2.

Conversões wire para interno:

| Wire | Interno |
|---|---|
| `participants[].user_id` | `userId` |
| `participants[].participant_sid` (pode faltar) | `participantSid: string \| null` |
| `participants[].provisional` | `provisional` |
| `tracks[].track_sid` | `trackSid` |
| `tracks[].source` | `source`, validado contra a união; valor desconhecido descarta a track |

Descartar uma track de `source` desconhecido, em vez de aceitar, é deliberado:
uma fonte que a UI não sabe renderizar não deve entrar no estado.

## 6. Casos de borda a tratar

1. Delta de canal desconhecido: pede snapshot daquele canal, não de todos.
2. Snapshot chegando enquanto há deltas pendentes: `awaitingSnapshot` bloqueia
   a aplicação dos deltas; o snapshot limpa a marca.
3. Servidor reiniciado: snapshot com versões menores é aceito (substituição
   total).
4. `setLiveParticipants` para um canal que não é o da sessão atual: ignorar
   (guard por `callSession.snapshot().channelId`).
5. Participante no LiveKit sem entrada na projeção do servidor: aparece com
   mute/deafen falsos. É o comportamento correto: melhor mostrar alguém sem
   metadados do que esconder quem é ouvido.
6. Bot de música: identidade fixa; `isBot` inferido da identidade quando não há
   overlay.
7. Nosso próprio participante local: entra em `participants` com `isLocal:
   true`. A UI já tem lógica para exibir a si mesmo com estado otimista
   (`App.tsx:3074-3084`), que passa a usar `isLocal` em vez de comparar ids.
8. `voice.roster` v1 com lista vazia: apaga a chave, comportamento preservado.
9. Delta com todos os arrays vazios: o servidor não emite (`is_empty`), mas se
   chegar, aplicar a versão e emitir sem mudança de conteúdo.
10. `emit()` chamado em cascata: usar um único `emit` por operação, nunca
    dentro do laço de aplicação.

## 7. Critérios de aceite

- **Dado** que estou em um canal com A e B, **quando** o servidor manda um
  delta removendo A mas o LiveKit ainda tem A, **então** A **continua** na
  minha lista de participantes. **INV-C1, o critério central.**
- **Dado** que A sai de verdade do LiveKit, **então** A some da minha lista em
  menos de 1 s, sem depender do servidor.
- **Dado** um delta com `previous_version` diferente da minha versão local,
  **então** o cliente pede snapshot e não aplica o delta.
- **Dado** um snapshot com versões menores que as locais (restart do servidor),
  **então** o cliente aceita o snapshot.
- **Dado** o mesmo delta entregue duas vezes, **então** o segundo é ignorado.
- **Dado** um servidor sem `voice.room.v2` em `features`, **então** o cliente
  consome `voice.rooms` e `voice.roster` e a UI funciona igual.
- **Dado** uma troca de canal, **então** o listener de IPC **não** é recriado
  (verificável por um contador de montagens em desenvolvimento).
- **Dado** 20 deltas em 1 s, **então** a UI re-renderiza no máximo 20 vezes e
  nenhum `<video>` remonta.

## 8. Como testar

### Automatizado — `client/ui/src/voiceStore.test.ts`

Testes U-20 a U-23 de `07-test-plan.md` §2, mais:

| Teste | Cenário |
|---|---|
| `session_participants_come_only_from_live` | delta adiciona X; `setLiveParticipants` não tem X; sessão não tem X |
| `session_overlay_applies_mute_from_delta` | delta marca A mudo; sessão reflete |
| `v1_roster_converts_to_the_same_shape` | `voice.roster` v1 produz `RoomProjection` equivalente |
| `unknown_track_source_is_dropped` | `source: "wat"` não entra |
| `delta_for_unknown_channel_requests_snapshot` | verifica o `send` |

### Manual

Roteiro M-01 (fantasma de canal) e M-07 (restart do app), agora com o cliente
v2. M-01 passo 6 é o critério: B fala e A não ouve, **e** A não vê B.

Teste adicional de convergência, com duas máquinas:

1. A e B em call. Na máquina de A, abrir o DevTools do WebView2 e bloquear
   temporariamente as mensagens de `voice.room.delta` (ou simplesmente parar o
   container do servidor por 20 s).
2. B sai do canal de verdade.
3. A deve ver B sumir da lista **imediatamente**, porque o `Room` do LiveKit
   informa a desconexão, independentemente do servidor.

Esse passo 3 é a demonstração prática de por que INV-C1 vale a pena.

## 9. Riscos e rollback

| Risco | Mitigação |
|---|---|
| `useSyncExternalStore` com `getState` devolvendo objeto novo causa loop | `getState` devolve a referência guardada; só `emit` cria objeto novo |
| Remover a dependência do `useEffect` esconde bugs de closure em chat | Trocar por refs de forma mecânica e rodar M-01 e um teste manual de chat |
| A sessão vinda do `Room` mostra gente sem metadados por um instante | Aceito e correto: melhor sem metadados que ausente |
| O cliente v2 falando com servidor v1 antigo (rollback do servidor) | `hasFeature` decide o dialeto; caminho v1 mantido e testado |

**Rollback:** `git revert`. Como `ClientProtocolVersion` volta a 1, o servidor
passa a mandar v1 automaticamente.

## 10. Fora de escopo

- Não mudar a renderização de vídeo (SPEC-009).
- Não mexer em publicação de tela (SPEC-010) nem em spectator (SPEC-011).
- Não memoizar componentes (SPEC-013).
- Não quebrar `App.tsx` em arquivos; só remover o estado de voz dele.
- Não tocar em chat, presença, atividade, anexos ou update.
