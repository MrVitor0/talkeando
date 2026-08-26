# 09 — WebSocket Protocol

Status: Histórico — contratos substituídos por `specs/*.md` + `contracts/websocket-events.md`
Owner/Domain: Backend + Cliente (protocolo compartilhado)
Requisitos: `WS-FR-*`, `CHAT-FR-*`, `PRES-FR-*`, `CALL-FR-*`, `RTC-FR-*`,
`SUB-FR-*`, `SCREEN-FR-*`, `CAM-FR-*`, `DEV-FR-003`
Ver também: `contracts/websocket-events.md` (mesma informação em formato de
referência rápida/schema), `state-machines/websocket.md`,
`12-stream-subscription-model.md`, `11-call-state-machine.md`

## Objetivo

Catálogo completo, com um exemplo de payload para cada operação, de toda
mensagem que trafega no WebSocket entre cliente e servidor. Este é o
protocolo em tempo real do sistema — tudo que precisa latência baixa ou
broadcast (chat ao vivo, presença, sinalização RTC, subscrição de stream)
passa por aqui.

## Contexto — envelope e convenções

Todo frame WS é um JSON com o mesmo envelope:

```json
{ "v": 1, "op": "<namespace>.<action>", "data": { } }
```

Erros usam o namespace especial `error`:

```json
{ "v": 1, "op": "error", "data": { "code": "not_participant", "message": "you are not a participant of this call", "in_reply_to": "rtc.ice" } }
```

- `v` é a versão do protocolo (hoje sempre `1`; um bump futuro é um novo
  ADR, ver `27-decisions.md`).
- Toda mensagem de mutação enviada pelo cliente carrega `data.req_id`
  (string gerada pelo cliente, ex. UUID v4 ou contador monotônico
  prefixado); o servidor ecoa esse `req_id` no ack/erro correspondente
  (`WS-FR-006`), permitindo ao cliente correlacionar resposta com intenção
  mesmo sob múltiplas mutações em voo simultaneamente.
- `[S→C]` = apenas servidor→cliente. `[bidi]` = ambos sentidos (com shapes
  diferentes conforme a direção, detalhado por op). Sem anotação = cliente→
  servidor, com uma resposta implícita descrita na entrada.

## `auth.*` — handshake

### `auth.hello` (cliente→servidor, primeira mensagem obrigatória — `WS-FR-001`)
```json
{ "v": 1, "op": "auth.hello", "data": { "token": "base64url-session-token", "req_id": "req-1" } }
```

### `auth.ok` [S→C]
```json
{ "v": 1, "op": "auth.ok", "data": { "user_id": "3e2f...-uuid", "req_id": "req-1" } }
```
Após `auth.ok`, o servidor envia imediatamente `presence.snapshot`.

### `auth.rejected` [S→C]
```json
{ "v": 1, "op": "auth.rejected", "data": { "code": "invalid_token", "req_id": "req-1" } }
```
Servidor fecha a conexão logo em seguida (o único caso em que uma falha de
protocolo justifica fechar o socket, pois não há sessão autenticada para
manter viva).

## `presence.*`

### `presence.snapshot` [S→C] (enviado uma vez, logo após `auth.ok`)
```json
{
  "v": 1, "op": "presence.snapshot",
  "data": { "members": [
    { "user_id": "uuid-a", "status": "online" },
    { "user_id": "uuid-b", "status": "idle" },
    { "user_id": "uuid-c", "status": "offline" }
  ] }
}
```

### `presence.update` [S→C] (broadcast quando o status de alguém muda)
```json
{ "v": 1, "op": "presence.update", "data": { "user_id": "uuid-b", "status": "online" } }
```
`status` ∈ `online | idle | offline` (`PRES-FR-*`).

## `chat.*`

### `chat.message.create`
```json
{ "v": 1, "op": "chat.message.create", "data": {
  "req_id": "req-42", "channel_id": "uuid-channel",
  "content": "bora call?", "attachment_ids": []
} }
```

### `chat.message.created` [S→C, broadcast a todos os membros conectados]
```json
{ "v": 1, "op": "chat.message.created", "data": {
  "req_id": "req-42",
  "message": { "id": "uuid-msg", "channel_id": "uuid-channel", "author_id": "uuid-a",
    "content": "bora call?", "created_at": "2026-08-26T20:04:11Z",
    "edited_at": null, "deleted_at": null, "attachments": [] }
} }
```

### `chat.message.edit`
```json
{ "v": 1, "op": "chat.message.edit", "data": { "req_id": "req-43", "message_id": "uuid-msg", "content": "bora call daqui 5min" } }
```

### `chat.message.edited` [S→C broadcast]
```json
{ "v": 1, "op": "chat.message.edited", "data": { "req_id": "req-43", "message_id": "uuid-msg", "content": "bora call daqui 5min", "edited_at": "2026-08-26T20:05:00Z" } }
```

### `chat.message.delete`
```json
{ "v": 1, "op": "chat.message.delete", "data": { "req_id": "req-44", "message_id": "uuid-msg" } }
```

### `chat.message.deleted` [S→C broadcast]
```json
{ "v": 1, "op": "chat.message.deleted", "data": { "req_id": "req-44", "message_id": "uuid-msg", "deleted_at": "2026-08-26T20:06:00Z" } }
```
Nota: o payload nunca inclui o `content` original — o cliente que já tinha a
mensagem em memória a substitui por um placeholder local (`CHAT-FR-003`).

### `chat.typing` [bidi, efêmero, nunca persistido — `CHAT-FR-004`]
```json
// cliente → servidor
{ "v": 1, "op": "chat.typing", "data": { "channel_id": "uuid-channel" } }
// servidor → outros clientes do canal
{ "v": 1, "op": "chat.typing", "data": { "channel_id": "uuid-channel", "user_id": "uuid-a" } }
```
Sem `req_id` (não é uma mutação que precisa de ack) e sem persistência —
o servidor apenas repassa, com TTL de exibição client-side (ex. 5s) definido
em `18-ux-spec.md`.

## `call.*`

### `call.join`
```json
{ "v": 1, "op": "call.join", "data": { "req_id": "req-50", "channel_id": "uuid-voice-channel" } }
```

### `call.snapshot` [S→C, resposta direta a quem entrou]
```json
{ "v": 1, "op": "call.snapshot", "data": {
  "req_id": "req-50", "channel_id": "uuid-voice-channel",
  "participants": [
    { "user_id": "uuid-a", "muted": false, "deafened": false, "joined_at": "2026-08-26T19:00:00Z" },
    { "user_id": "uuid-b", "muted": true, "deafened": false, "joined_at": "2026-08-26T19:05:00Z" }
  ],
  "streams": [
    { "id": "uuid-stream-1", "owner": "uuid-b", "kind": "screen", "metadata": { "label": "Monitor 1", "has_audio": false } }
  ]
} }
```

### `call.peer_joined` [S→C broadcast aos demais participantes]
```json
{ "v": 1, "op": "call.peer_joined", "data": { "channel_id": "uuid-voice-channel", "user_id": "uuid-c", "joined_at": "2026-08-26T20:10:00Z" } }
```

### `call.leave`
```json
{ "v": 1, "op": "call.leave", "data": { "req_id": "req-51", "channel_id": "uuid-voice-channel" } }
```

### `call.peer_left` [S→C broadcast]
```json
{ "v": 1, "op": "call.peer_left", "data": { "channel_id": "uuid-voice-channel", "user_id": "uuid-c" } }
```

Mute/deafen não têm ops próprias no catálogo — são refletidos como um
`call.participant_updated` [S→C broadcast], emitido a partir de uma
mutação `call.self_update` (cliente→servidor):

### `call.self_update`
```json
{ "v": 1, "op": "call.self_update", "data": { "req_id": "req-52", "channel_id": "uuid-voice-channel", "muted": true, "deafened": false } }
```
### `call.participant_updated` [S→C broadcast]
```json
{ "v": 1, "op": "call.participant_updated", "data": { "channel_id": "uuid-voice-channel", "user_id": "uuid-a", "muted": true, "deafened": false } }
```

## `rtc.*` — sinalização (relay opaco, servidor nunca interpreta o SDP)

Todas as três ops abaixo têm o mesmo formato de envelope: `from_user` é
sempre preenchido pelo servidor a partir da conexão autenticada (nunca
confiado do payload do cliente); `to_user` é o destinatário pretendido.

### `rtc.offer` [bidi]
```json
// cliente → servidor
{ "v": 1, "op": "rtc.offer", "data": { "req_id": "req-60", "to_user": "uuid-b", "sdp": "v=0\r\no=- ... (SDP opaco)" } }
// servidor → to_user
{ "v": 1, "op": "rtc.offer", "data": { "from_user": "uuid-a", "sdp": "v=0\r\no=- ..." } }
```

### `rtc.answer` [bidi] — mesmo formato, `sdp` do tipo answer
```json
{ "v": 1, "op": "rtc.answer", "data": { "from_user": "uuid-b", "sdp": "v=0\r\no=- ..." } }
```

### `rtc.ice` [bidi]
```json
{ "v": 1, "op": "rtc.ice", "data": { "from_user": "uuid-a", "to_user": "uuid-b",
  "candidate": { "candidate": "candidate:1 1 udp 2130706431 192.168.1.5 54321 typ host", "sdpMid": "0", "sdpMLineIndex": 0 } } }
```

Autorização (`RTC-FR-008`): servidor só faz o relay se `from_user` (a
conexão remetente) e `to_user` estão ambos, no momento do envio,
registrados como participantes da mesma `ActiveCall` no `CallRegistry`.
Caso contrário → `error { code: "not_participant" }`.

### `rtc.connection_state` [C→S, telemetria apenas — `RTC-FR §`, `OBS-NFR-004`]
```json
{ "v": 1, "op": "rtc.connection_state", "data": { "peer_user_id": "uuid-b", "state": "connected" } }
```
`state` ∈ valores do `RTCPeerConnectionState` (`new|connecting|connected|
disconnected|failed|closed`). Servidor apenas loga; nunca persiste, nunca
reage automaticamente (reação a `failed` é decisão do próprio cliente via
ICE restart — ver `state-machines/peer.md`).

## `stream.*` — publish/subscribe (ver `12-stream-subscription-model.md` para a
semântica completa; aqui só o shape das mensagens)

### `stream.publish`
```json
{ "v": 1, "op": "stream.publish", "data": { "req_id": "req-70", "channel_id": "uuid-voice-channel", "kind": "screen", "metadata": { "label": "Monitor 1", "has_audio": false } } }
```

### `stream.published` [S→C broadcast a todos na call]
```json
{ "v": 1, "op": "stream.published", "data": { "stream_id": "uuid-stream-1", "owner": "uuid-b", "kind": "screen", "channel_id": "uuid-voice-channel", "metadata": { "label": "Monitor 1", "has_audio": false } } }
```

### `stream.unpublish`
```json
{ "v": 1, "op": "stream.unpublish", "data": { "req_id": "req-71", "stream_id": "uuid-stream-1" } }
```

### `stream.unpublished` [S→C broadcast]
```json
{ "v": 1, "op": "stream.unpublished", "data": { "stream_id": "uuid-stream-1" } }
```
Implica cancelamento implícito de todas as subscrições daquele stream nos
clientes que o assinavam — cada um deles trata este evento como o gatilho
para parar de esperar mídia desse `stream_id` (`SUB-FR-008`).

### `stream.subscribe`
```json
{ "v": 1, "op": "stream.subscribe", "data": { "req_id": "req-72", "stream_id": "uuid-stream-1" } }
```

### `stream.subscription_requested` [S→C, apenas ao owner do stream]
```json
{ "v": 1, "op": "stream.subscription_requested", "data": { "stream_id": "uuid-stream-1", "viewer_user_id": "uuid-a" } }
```
O cliente do owner reage ativando o RTP sender daquela track **apenas** para
a `RTCPeerConnection` com `uuid-a`, e caso necessário renegocia via
`rtc.offer`/`rtc.answer` naquela mesma conexão (`SUB-FR-002`).

### `stream.unsubscribe`
```json
{ "v": 1, "op": "stream.unsubscribe", "data": { "req_id": "req-73", "stream_id": "uuid-stream-1" } }
```
Encaminhado da mesma forma ao owner (evento `stream.unsubscribe_requested`
[S→C], mesmo shape trocando o nome do campo de ação), que desativa o sender
para aquele peer específico (`SUB-FR-003`).

## `device.*`

### `device.list_changed` [C→S, informacional/telemetria apenas — `DEV-FR-003`]
```json
{ "v": 1, "op": "device.list_changed", "data": { "kind": "audio_input" } }
```
`kind` ∈ `audio_input | audio_output | camera`. O servidor apenas loga; a
enumeração real do dispositivo é sempre local ao cliente — este op não
retorna nenhuma lista.

## Tabela-resumo de todos os ops

| Op | Direção | Mutação persistida? | Requer estar em call? |
|---|---|---|---|
| `auth.hello` / `auth.ok` / `auth.rejected` | bidi/S→C | não | não |
| `presence.snapshot` / `presence.update` | S→C | não (efêmero, derivado de conexão) | não |
| `chat.message.create/created` | bidi | sim | não |
| `chat.message.edit/edited` | bidi | sim | não |
| `chat.message.delete/deleted` | bidi | sim (soft) | não |
| `chat.typing` | bidi | não | não |
| `call.join` → `call.snapshot`+`call.peer_joined` | bidi/S→C | não (in-memory) | — |
| `call.leave` → `call.peer_left` | bidi/S→C | não | sim |
| `call.self_update` → `call.participant_updated` | bidi/S→C | não | sim |
| `rtc.offer/answer/ice` | bidi (relay) | não | sim (ambos os lados) |
| `rtc.connection_state` | C→S | não (log apenas) | sim |
| `stream.publish/published` | bidi/S→C | não (in-memory) | sim |
| `stream.unpublish/unpublished` | bidi/S→C | não | sim |
| `stream.subscribe` → `stream.subscription_requested` | bidi/S→C | não | sim |
| `stream.unsubscribe` → `stream.unsubscribe_requested` | bidi/S→C | não | sim |
| `device.list_changed` | C→S | não (log apenas) | não |
| `error` | S→C | — | — |

Schemas JSON versionados (para geração de tipos TS/C#) vivem em
`protocol/` — este documento e `contracts/websocket-events.md` devem
permanecer sincronizados com eles a cada mudança de payload.
