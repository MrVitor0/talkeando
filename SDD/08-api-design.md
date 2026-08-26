# 08 — API Design (REST)

Status: Histórico — contratos substituídos por `specs/*.md` + `contracts/rest-api.md`
Owner/Domain: Backend
Requisitos: `API-FR-*`, `AUTH-FR-*`, `CHAN-FR-*`, `CHAT-FR-*`, `ATTACH-FR-*`
Ver também: `contracts/rest-api.md` (contrato normativo exato — este
documento explica o *porquê* de cada endpoint; o contrato é a fonte de
verdade para o *shape* exato), `16-security.md`, `20-error-handling.md`

## Objetivo

Enumerar toda a superfície REST v1, com método, path, request/response e
códigos de status, agrupada por domínio. Tudo que é tempo-real (mensagens
chegando ao vivo, presença, sinalização de call) é WebSocket
(`09-websocket-protocol.md`) — REST é usado para: login/logout, CRUD de
estrutura (canais/categorias/convites), histórico paginado de mensagens, e
upload de anexos (que precisam de multipart, inadequado para WS).

## Contexto

- Toda rota (exceto `/auth/login`) exige `Authorization: Bearer <token>`.
- Toda resposta de erro segue o mesmo formato (`contracts/rest-api.md`
  §Error shape): `{ "error": { "code": "string", "message": "string" } }`.
- Content-Type de request/response é `application/json`, exceto upload de
  anexo (`multipart/form-data`).
- Paginação usa cursor opaco (base64 de `created_at`+`id`), nunca offset
  numérico (evita duplicação/omissão de linhas sob inserção concorrente).

## Auth (`AUTH-FR-*`, `API-FR-001`)

| Método | Path | Auth | Descrição |
|---|---|---|---|
| POST | `/auth/register` | nenhum (código de convite no corpo) | Cria usuário a partir de um `invite.code` válido |
| POST | `/auth/login` | nenhum | `{username, password}` → `{token, user}` |
| POST | `/auth/logout` | Bearer | Revoga a sessão atual (`revoked_at`) |
| GET | `/auth/me` | Bearer | Retorna o usuário autenticado atual |

`POST /auth/login` request/response:
```json
// request
{ "username": "vitor", "password": "•••••" }
// 200 response
{ "token": "base64url-opaque-token", "user": { "id": "uuid", "username": "vitor", "display_name": "Vitor" } }
// 401 response (genérico, AUTH-FR-008)
{ "error": { "code": "invalid_credentials", "message": "invalid credentials" } }
// 429 response (AUTH-NFR-004)
{ "error": { "code": "rate_limited", "message": "too many attempts, try again later" } }
```

`POST /auth/register`:
```json
// request
{ "invite_code": "XK3F9A", "username": "novo_membro", "password": "•••••", "display_name": "Novo Membro" }
// 201 response — same shape as login
// 400 invite_invalid | invite_expired | invite_exhausted | username_taken
```

## Communities / Channels / Categories (`CHAN-FR-*`, `API-FR-002`)

| Método | Path | Auth | Papel exigido | Descrição |
|---|---|---|---|---|
| GET | `/community` | Bearer | membro | Retorna a (única) comunidade + lista de membros |
| GET | `/community/categories` | Bearer | membro | Lista categorias ordenadas por `position`, cada uma com seus canais |
| POST | `/community/categories` | Bearer | owner | Cria categoria (`CHAN-FR-007`) |
| PATCH | `/community/categories/{id}` | Bearer | owner | Renomeia/reordena |
| DELETE | `/community/categories/{id}` | Bearer | owner | Remove categoria (canais ficam `category_id = null`) |
| POST | `/community/channels` | Bearer | owner | Cria canal (`kind: text\|voice`) |
| PATCH | `/community/channels/{id}` | Bearer | owner | Renomeia, muda tópico/posição/categoria |
| DELETE | `/community/channels/{id}` | Bearer | owner | Remove canal (mensagens são removidas em cascata a nível de FK) |

Não-owner chamando POST/PATCH/DELETE recebe `403 { "error": { "code":
"forbidden_not_owner" } }` (`CHAN-FR-008`).

## Messages (`CHAT-FR-*`, `API-FR-003`)

| Método | Path | Auth | Descrição |
|---|---|---|---|
| GET | `/channels/{channelId}/messages?before={cursor}&limit={n}` | Bearer | Histórico paginado, mais recente primeiro, `limit` default 50 max 100 |
| POST | `/channels/{channelId}/messages` | Bearer | Alternativa REST ao `chat.message.create` via WS — v1 usa WS como caminho primário para envio (entrega em tempo real imediata); este endpoint existe para reenvio idempotente de mensagens quando o WS está temporariamente indisponível (ver `20-error-handling.md` §retry de mensagem falhada) |
| PATCH | `/messages/{id}` | Bearer (autor) | Edição via REST (espelha `chat.message.edit`) |
| DELETE | `/messages/{id}` | Bearer (autor ou owner) | Soft delete (espelha `chat.message.delete`) |

Envio de mensagem em tempo real é **preferencialmente via WS**
(`chat.message.create`, ver `09-websocket-protocol.md`); os endpoints REST
de mutação existem como caminho de recuperação quando o socket está fora do
ar (fila local no cliente + retry via REST), não como caminho duplicado
concorrente — o cliente nunca envia a mesma mensagem por ambos os canais.

`GET /channels/{channelId}/messages` response:
```json
{
  "messages": [
    {
      "id": "uuid", "channel_id": "uuid", "author_id": "uuid",
      "content": "...", "created_at": "2026-08-20T10:00:00Z",
      "edited_at": null, "deleted_at": null,
      "attachments": [ { "id": "uuid", "filename": "img.png", "content_type": "image/png", "size_bytes": 20481, "url": "/attachments/uuid" } ]
    }
  ],
  "next_cursor": "opaque-base64-or-null"
}
```
Mensagens com `deleted_at != null` são retornadas com `content: null` e um
marcador `"deleted": true` — o cliente renderiza um placeholder
("mensagem excluída"), nunca lê `content` original.

## Attachments (`ATTACH-FR-*`, `API-FR-004`)

| Método | Path | Auth | Descrição |
|---|---|---|---|
| POST | `/attachments` | Bearer | `multipart/form-data`, campo `file`; retorna `{id, filename, content_type, size_bytes, storage_path_ref}` sem `message_id` ainda vinculado |
| GET | `/attachments/{id}` | Bearer (membro da comunidade) | Stream do arquivo (bytes), com `Content-Type` correto |

Fluxo: cliente faz `POST /attachments` primeiro, recebe o `id` do anexo, e
então envia `chat.message.create` (WS) incluindo `attachment_ids: [id]` — o
servidor vincula `attachments.message_id` ao criar a mensagem. Anexo sem
mensagem vinculada por >1h é limpo por uma rotina de coleta (ver
`21-observability.md`/manutenção — job simples, não um requisito de v1
crítico).

Limites (`ATTACH-FR-003/004`): tamanho máximo default 25MB por arquivo
(configurável via env `MAX_ATTACHMENT_SIZE_BYTES`); allowlist de
`content_type` cobre imagens comuns, vídeo curto, áudio, PDF, texto e
arquivos zip — tipos executáveis (`application/x-msdownload`,
`application/x-executable` etc.) são sempre rejeitados independente de
configuração, por padrão de segurança (`SEC-NFR-*`).

## Invites (`AUTH-FR-005`, `API-FR-005`)

| Método | Path | Auth | Papel | Descrição |
|---|---|---|---|---|
| POST | `/invites` | Bearer | owner | Cria convite `{max_uses?, expires_at?}` → `{id, code}` |
| GET | `/invites` | Bearer | owner | Lista convites ativos e usados |
| DELETE | `/invites/{id}` | Bearer | owner | Revoga (seta `expires_at = now()` se ainda válido) |

## Formato de erro consistente (`API-FR-006`)

Todo erro REST retorna:
```json
{ "error": { "code": "snake_case_stable_code", "message": "human readable, safe to show" } }
```
Códigos HTTP usados: `400` (validação), `401` (não autenticado/token
inválido), `403` (autenticado mas sem permissão), `404` (recurso não
existe ou não pertence ao chamador — nunca distinguido de "não existe" para
evitar vazamento de informação), `409` (conflito, ex. username já existe),
`413` (payload/arquivo grande demais), `422` (semanticamente inválido, ex.
`expires_at` no passado), `429` (rate limit), `500` (erro interno —
mensagem genérica "internal error", detalhe vai só para o log com
`req_id`, nunca para o corpo da resposta). Detalhe completo da taxonomia de
erro em `20-error-handling.md`.
