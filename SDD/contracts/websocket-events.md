# Contrato WebSocket v1

Status: Normativo
Fonte: `specs/*.md`; envelope: `{ "v": 1, "op": "namespace.action", "data": {} }`.

Toda mutação C→S possui `req_id`; o evento de sucesso/erro carrega
`in_reply_to`. O servidor injeta a identidade do remetente; o cliente nunca
informa `from_user` como dado confiável.

## Handshake e presença

| Op | Direção | Data |
|---|---|---|
| `auth.hello` | C→S | `{ token, req_id }` |
| `auth.ok` | S→C | `{ user, session_expires_at, in_reply_to }` |
| `auth.rejected` | S→C + close | `{ code, in_reply_to? }` |
| `presence.snapshot` | S→C | `{ users: [{ user_id, status }] }` |
| `presence.update` | S→C | `{ user_id, status }` |

`status` é `online|offline` na v1. Snapshot inclui todos os membros da
comunidade, não apenas sockets online.

## Chat

| Op | Direção | Data |
|---|---|---|
| `chat.message.create` | C→S | `{ req_id, channel_id, content, attachment_ids?: [] }` |
| `chat.message.created` | S→C | `{ message, in_reply_to? }` |
| `chat.message.edit` | C→S | `{ req_id, message_id, content }` |
| `chat.message.edited` | S→C | `{ message_id, content, edited_at, in_reply_to? }` |
| `chat.message.delete` | C→S | `{ req_id, message_id }` |
| `chat.message.deleted` | S→C | `{ message_id, channel_id, in_reply_to? }` |
| `chat.typing` | bidi | C→S `{ channel_id }`; S→C adiciona `user_id` |

## Call e RTC

| Op | Direção | Data |
|---|---|---|
| `call.join` | C→S | `{ req_id, channel_id, muted?: false, deafened?: false }` |
| `call.snapshot` | S→C | `{ channel_id, participants, streams, in_reply_to }` |
| `call.peer_joined` | S→C | `{ channel_id, participant }` |
| `call.leave` | C→S | `{ req_id, channel_id }` |
| `call.peer_left` | S→C | `{ channel_id, user_id, reason: "left"|"disconnected"|"channel_deleted" }` |
| `call.state.update` | bidi | C→S `{ req_id, channel_id, muted?, deafened? }`; S→C `{ channel_id, user_id, muted, deafened, in_reply_to? }` |
| `rtc.offer` / `rtc.answer` | bidi relay | C→S `{ req_id, channel_id, to_user, sdp }`; S→C adiciona `from_user` |
| `rtc.ice` | bidi relay | C→S `{ req_id, channel_id, to_user, candidate }`; S→C adiciona `from_user` |
| `rtc.connection_state` | C→S | `{ channel_id, peer_user_id, state }` |

RTC relay requer ambos os usuários na mesma call e não interpreta SDP/ICE.

## Streams e erros

| Op | Direção | Data |
|---|---|---|
| `stream.publish` | C→S | `{ req_id, channel_id, stream_id, kind: "screen", label?, has_audio? }` |
| `stream.published` | S→C | `{ channel_id, stream_id, owner, kind, label?, has_audio, in_reply_to? }` |
| `stream.unpublish` | C→S | `{ req_id, channel_id, stream_id }` |
| `stream.unpublished` | S→C | `{ channel_id, stream_id, in_reply_to? }` |
| `stream.subscribe` | C→S | `{ req_id, channel_id, stream_id }` |
| `stream.subscription_requested` | S→C owner | `{ channel_id, stream_id, subscriber, in_reply_to? }` |
| `stream.unsubscribe` | C→S | `{ req_id, channel_id, stream_id }` |
| `stream.unsubscribed` | S→C owner | `{ channel_id, stream_id, subscriber, in_reply_to? }` |
| `error` | S→C | `{ code, message, in_reply_to? }` |

Publicar não habilita mídia para ninguém. O publisher só habilita o sender
para o subscriber explicitamente informado pelo servidor.

