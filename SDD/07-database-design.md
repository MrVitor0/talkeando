# 07 — Database Design

Status: Decidido (canon §7 — schema mínimo v1)
Owner/Domain: Backend / persistência
Requisitos: `DB-FR-*`, `AUTH-FR-*`, `CHAN-FR-*`, `CHAT-FR-*`, `ATTACH-FR-*`
Ver também: `06-backend-architecture.md`, `contracts/database-contracts.md`,
`23-local-development.md` (como rodar migrations localmente)

## Objetivo

Especificar o schema Postgres completo de v1, entidade por entidade, com
definições estilo SQL e a prosa que explica cada decisão de modelagem.
Migrations reais vivem em `server/migrations/` (arquivos `.sql`
timestamp-prefixados, aplicados via SQLx CLI/migrator embutido).

## Contexto

Postgres 16, acessado via SQLx com queries verificadas em compile-time
(`sqlx::query!`) onde praticável, `query` dinâmico para os poucos casos que
precisam de SQL construído em runtime (ex.: paginação com filtros
opcionais). Todo ID de entidade é UUID v4 ("opaque ID") — nenhuma tabela usa
serial/bigint como chave primária pública.

## Escopo

Todas as tabelas abaixo são persistidas em Postgres. **Calls, streams e
estado de peer NÃO são persistidos** — ver `06-backend-architecture.md`
§CallRegistry e `contracts/database-contracts.md` para a linha exata entre
"vive no banco" e "vive só em memória".

## Schema completo

```sql
-- users: identidade e credencial
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        TEXT NOT NULL UNIQUE,
    display_name    TEXT NOT NULL,
    password_hash   TEXT NOT NULL,           -- Argon2id encoded hash (AUTH-NFR-001)
    avatar_color    TEXT,                     -- nullable; hex color used when no avatar_url
    avatar_url      TEXT,                     -- nullable; local/static path in v1 (no external CDN)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- sessions: token opaco, só o hash é guardado (AUTH-NFR-002)
CREATE TABLE sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL UNIQUE,     -- SHA-256(raw token), hex-encoded
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,     -- created_at + 30 days, refreshed on use (AUTH-FR-003)
    revoked_at      TIMESTAMPTZ,              -- set on logout (AUTH-FR-004)
    user_agent      TEXT
);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);

-- communities: v1 seeds exactly one row (CHAN-FR-001)
CREATE TABLE communities (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE community_role AS ENUM ('owner', 'member');

-- community_members: papel do usuário na (única) comunidade (CHAN-FR-002)
CREATE TABLE community_members (
    community_id    UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            community_role NOT NULL DEFAULT 'member',
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, user_id)
);

-- channel_categories: grupos colapsáveis na sidebar (CHAN-FR-003)
CREATE TABLE channel_categories (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    community_id    UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    position        INT NOT NULL DEFAULT 0
);
CREATE INDEX idx_categories_community ON channel_categories(community_id);

CREATE TYPE channel_kind AS ENUM ('text', 'voice');

-- channels (CHAN-FR-004)
CREATE TABLE channels (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    community_id    UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    category_id     UUID REFERENCES channel_categories(id) ON DELETE SET NULL,
    name            TEXT NOT NULL,
    kind            channel_kind NOT NULL,
    topic           TEXT,
    position        INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_channels_community ON channels(community_id);

-- channel_members: exists for future per-channel ACL; v1 does NOT enforce
-- anything beyond community membership (CHAN-FR-006 — explicit scope cut,
-- not an accidental gap). Present so a future migration can add real ACL
-- rows without a schema change.
CREATE TABLE channel_members (
    channel_id      UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, user_id)
);

-- messages (CHAT-FR-001/002/003)
CREATE TABLE messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id      UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content         TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at       TIMESTAMPTZ,             -- set on edit (CHAT-FR-002)
    deleted_at      TIMESTAMPTZ              -- soft delete (CHAT-FR-003); content is retained, never physically removed
);
CREATE INDEX idx_messages_channel_created ON messages(channel_id, created_at DESC);

-- reactions: schema exists, no v1 UI (CHAT-FR-006 — deferred, not missing)
CREATE TABLE reactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id      UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji           TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (message_id, user_id, emoji)
);

-- attachments (ATTACH-FR-*)
CREATE TABLE attachments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id      UUID REFERENCES messages(id) ON DELETE CASCADE, -- nullable while uploading, before message is created
    uploader_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename        TEXT NOT NULL,
    content_type    TEXT NOT NULL,
    size_bytes      BIGINT NOT NULL,
    storage_path    TEXT NOT NULL,            -- local disk path in v1, see ATTACH-FR-002
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_attachments_message ON attachments(message_id);

-- invites (AUTH-FR-005)
CREATE TABLE invites (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    community_id    UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    created_by      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code            TEXT NOT NULL UNIQUE,
    max_uses        INT,                      -- nullable = unlimited
    uses            INT NOT NULL DEFAULT 0,
    expires_at      TIMESTAMPTZ,               -- nullable = never expires
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## Convenções de migração

- Arquivos em `server/migrations/`, nomeados
  `YYYYMMDDHHMMSS_<description>.sql`, aplicados via `sqlx migrate run` (ou
  o migrator embutido no binário no boot, atrás de uma flag de config —
  decisão de qual dos dois é o padrão de produção fica em
  `24-deployment.md`).
- Nunca editar uma migration já aplicada em qualquer ambiente compartilhado
  — uma correção é sempre uma nova migration.
- Toda tabela nova precisa: chave primária UUID com `gen_random_uuid()`
  (requer extensão `pgcrypto` ou usar geração de UUID no lado da aplicação
  via crate `uuid` antes do insert — v1 usa geração no lado Rust com
  `Uuid::new_v4()` para evitar dependência de extensão Postgres, então os
  `DEFAULT gen_random_uuid()` acima são a forma de referência do schema;
  a aplicação sempre envia o UUID explicitamente no INSERT).

## Não persistido em banco (lembrete)

Calls ativas, participantes de call, `PublishedStream`s e qualquer estado
de `PeerConnection` são **exclusivamente in-memory** no processo do
backend (`CallRegistry`, ver `06-backend-architecture.md`). Isso é
proposital (`DB-FR-002`): são efêmeros por natureza e persisti-los criaria
o problema de "call fantasma" sobrevivendo a um restart do servidor.

## Índices e padrões de acesso esperados

| Tabela | Padrão de acesso dominante | Índice |
|---|---|---|
| `messages` | Paginação por canal, mais recentes primeiro | `(channel_id, created_at DESC)` |
| `sessions` | Lookup por `token_hash` no middleware de auth (a cada request) | `UNIQUE(token_hash)` (implícito) |
| `channel_categories`/`channels` | Listagem completa por comunidade, ordenada por `position` | `community_id` |
| `attachments` | Lookup por mensagem ao renderizar histórico | `message_id` |

## Considerações de concorrência a nível de banco

- Edição/exclusão de mensagem é idempotente e verificada por
  `author_id = current_user` (ou `role = owner` para exclusão) na query —
  nunca confiar em um `message_id` vindo do cliente sem essa checagem
  (`CHAT-FR-008`).
- `invites.uses` é incrementado atomicamente
  (`UPDATE invites SET uses = uses + 1 WHERE id = $1 AND (max_uses IS NULL
  OR uses < max_uses) RETURNING uses`) para evitar corrida de dois
  registros simultâneos excedendo `max_uses`.
