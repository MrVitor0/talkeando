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
| `presence.set` | C→S | `{ status: "online" \| "busy" }` — override manual do próprio status |

`status` é `online|busy|offline`. `busy` (Não Perturbe) é um override em
memória por usuário no `Hub`, definido por `presence.set` e limpo quando o
último socket do usuário cai. Enquanto `busy`, o cliente silencia o som de
notificação de novas mensagens (efeito client-side). Snapshot inclui todos os
membros da comunidade, não apenas sockets online.

## Atividade (rich presence)

| Op | Direção | Data |
|---|---|---|
| `activity.report` | C→S | `{ activities: [Activity], req_id? }` — fire-and-forget, sem ack; substitui a lista inteira do usuário |
| `activity.snapshot` | S→C | `{ users: [{ user_id, activities: [Activity] }] }` — uma vez, após `presence.snapshot`; só membros com atividade não-vazia |
| `activity.update` | S→C | `{ user_id, activities: [Activity] }` — broadcast em mudança; `[]` = limpou |

`Activity = { kind: "playing"|"listening"|"watching"|"browsing", name,
details?, state?, started_at?, asset_image?, asset_text? }`. Detecção é no
cliente nativo: SMTC (mídia) + Steam/lista curada (jogos). `asset_image` é um
ref opaco resolvido pela UI: `"steam:<appid>"`, `"att:<sha256>"`
(`GET /api/activity-assets/:id`, sem auth) ou URL absoluta. Efêmero, nunca
persistido. Servidor sanea (≤4 itens, clamp de strings) e faz dedupe.

Só **S→C** e só para `kind: "playing"`, o servidor acrescenta campos
derivados do ledger `game_sessions`: `total_seconds` (int), `last_played_at`
(RFC3339), `is_new` (bool — 1ª sessão < 24h). O cliente nunca envia esses
campos (são zerados na entrada). Ver `specs/activity.md`.

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

## Perfil e canais (edições "botão direito")

Sem op de entrada — as mutações entram por REST (`PATCH /api/me`,
`POST /api/me/avatar`, `PATCH /api/users/:id`, `PATCH /api/channels/:id/name`)
e o servidor faz o fan-out abaixo para a comunidade.

| Op | Direção | Data |
|---|---|---|
| `member.updated` | S→C | `{ user_id, display_name, avatar_url?, avatar_color?, profile_tag? }` — renome ou troca de avatar; broadcast para quem compartilha comunidade. O host converte `avatar_url` para `data:` URI. |
| `channel.updated` | S→C | `{ id, name, kind, category_id? }` — canal renomeado (só nome). |

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

## Música

| Op | Direção | Data |
|---|---|---|
| `music.command` | C→S→bot | `{ channel_id, voice_channel_id, command: "play"|"pause"|"resume"|"skip"|"stop"|"queue", query? }` |
| `music.status` | bot→S | `{ status_id, channel_id, kind, origin?, provider?, title?, artist?, detail?, count?, position?, queue_size?, duration_ms?, total_duration_ms?, eta_ms?, image_url?, source_url?, collection_name?, collection_kind?, requested_by?, items? }` |
| `music.announcement` | S→C | mesmo payload validado de `music.status` |

O comando requer que o usuário esteja no canal de voz e seja membro do canal
de texto. Somente a identidade fixa do bot publica estados. Os anúncios não são
persistidos; a UI os mantém por canal durante a sessão.

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
