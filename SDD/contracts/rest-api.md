# Contrato REST v1

Status: Normativo
Fonte: `specs/auth.md`, `specs/channels.md`, `specs/chat.md`, `08-api-design.md`

Base path: `/api`; JSON UTF-8, salvo upload `multipart/form-data`.
Rotas autenticadas exigem `Authorization: Bearer <token>`.

## Convenções

```json
// erro
{ "code": "snake_case", "message": "safe human-readable text" }
```

`401` é token ausente/inválido; `403` é autenticado sem permissão; `404` não
revela a existência de recurso inacessível; `409` é conflito; `413` é arquivo
grande; `429` inclui `retry_after_seconds` quando aplicável.

## Auth e convites

| Método e path | Corpo | Resposta |
|---|---|---|
| `POST /auth/register` | `{ invite_code, username, display_name, password }` | `201 { token, user, session_expires_at }` |
| `POST /auth/login` | `{ username, password }` | `200 { token, user, session_expires_at }` |
| `POST /auth/logout` | — | `204` |
| `GET /auth/me` | — | `200 { user, communities }` |
| `POST /invites` | `{ max_uses?: number|null, expires_in_seconds?: number|null }` | `201 { code, expires_at }` (owner) |
| `GET /invites` | — | `200 { invites }` (owner) |
| `DELETE /invites/{id}` | — | `204` (owner) |

`user = { id, username, display_name, avatar_color }`. Usernames are
normalizados para `[a-z0-9_]{3,24}`; erros de login são sempre
`401 invalid_credentials`.

## Comunidade, membros e canais

| Método e path | Corpo | Resposta |
|---|---|---|
| `GET /community` | — | `200 { id, name, members: [Member] }` |
| `GET /channels` | — | `200 { categories, uncategorized_channels }` |
| `POST /channels/categories` | `{ name, position? }` | `201 Category` (owner) |
| `PATCH /channels/categories/{id}` | `{ name?, position? }` | `200 Category` (owner) |
| `DELETE /channels/categories/{id}` | — | `204` (owner) |
| `POST /channels` | `{ name, kind, category_id?, topic?, position? }` | `201 Channel` (owner) |
| `PATCH /channels/{id}` | `{ name?, topic?, category_id?, position? }` | `200 Channel` (owner) |
| `DELETE /channels/{id}` | — | `204` (owner) |

`Member = { id, username, display_name, avatar_color, role }`.
`Category = { id, name, position, channels?: [Channel] }`.
`Channel = { id, name, kind: "text"|"voice", category_id, topic, position }`.
Excluir categoria deixa seus canais sem categoria. Excluir canal de voz
termina sua call antes de remover o registro persistido.

## Histórico e anexos

| Método e path | Corpo | Resposta |
|---|---|---|
| `GET /channels/{id}/messages?before={uuid}&limit={1..100}` | — | `200 { messages, has_more }` |
| `POST /channels/{id}/attachments` | multipart `file` | `201 Attachment` |
| `GET /attachments/{id}` | — | bytes com Content-Type original |

`Message = { id, channel_id, author: User, content, created_at, edited_at,
attachments }`; mensagens removidas não retornam conteúdo. `Attachment = {
id, filename, content_type, size_bytes, url }`. O upload só aceita tipos da
allowlist e respeita `MAX_ATTACHMENT_SIZE_BYTES` (default 25 MiB).

Criação, edição e exclusão de mensagens são WS-only na v1; REST não fornece
um segundo caminho de mutação concorrente.

## RTC

| Método e path | Resposta |
|---|---|
| `GET /turn-credentials` | `200 { username, credential, ttl_seconds, uris }` |

As credenciais TURN são curtas, HMAC, emitidas apenas para sessão válida.

