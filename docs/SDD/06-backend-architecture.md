# 06 — Backend Architecture

Status: Decidido
Owner/Domain: Backend (Rust)
Requisitos: `CALL-FR-*`, `RTC-FR-*`, `SUB-FR-*`, `WS-FR-*`, `API-FR-*`, `DB-FR-*`
Ver também: `04-system-architecture.md`, `07-database-design.md`,
`08-api-design.md`, `09-websocket-protocol.md`, `state-machines/websocket.md`

## Objetivo

Descrever a estrutura interna do binário `server` (Rust/Axum): módulos,
camadas, como REST e WS compartilham estado, e o design exato do
`CallRegistry` — a única estrutura de estado verdadeiramente concorrente do
sistema.

## Contexto

O backend é um único binário Tokio/Axum. Não há filas externas, não há
cache externo (Redis etc.) — tudo que precisa ser rápido e compartilhado
entre conexões vive em memória do próprio processo, protegido por
primitivas do Tokio (`RwLock`/`Mutex` async, ou um ator por entidade onde
fizer sentido).

## Estrutura de módulos (proposta de organização de `server/src/`)

```
server/src/
├── main.rs              — bootstrap, parse de config/env, comando --bootstrap-owner
├── config.rs             — carregamento de env vars (DB URL, TURN shared secret, etc.)
├── db/                    — camada de acesso a dados (SQLx), um módulo por entidade
│   ├── users.rs, sessions.rs, communities.rs, channels.rs, messages.rs,
│   │   reactions.rs, attachments.rs, invites.rs
├── auth/                  — hashing Argon2id, emissão/validação de sessão, middleware Bearer
├── rest/                  — handlers Axum REST, um módulo por recurso (ver 08-api-design.md)
│   ├── auth.rs, channels.rs, messages.rs, attachments.rs, invites.rs
├── ws/                    — hub de WebSocket
│   ├── hub.rs             — registro de conexões ativas, dispatch de envelope
│   ├── handlers/          — um handler por namespace de op (chat.*, presence.*, call.*, rtc.*, stream.*)
│   └── envelope.rs        — tipos serde do envelope {v, op, data}
├── call/                  — CallRegistry e autorização de sinalização
│   ├── registry.rs        — CallRegistry, ActiveCall, ParticipantState (in-memory, canon §6)
│   └── authz.rs           — checagens "sender é participante", "stream pertence ao owner", etc.
├── turn/                  — geração de credenciais TURN HMAC de curta duração
├── telemetry.rs           — setup de tracing-subscriber (JSON em prod)
└── error.rs               — tipo de erro central, mapeado para respostas REST e envelopes WS "error"
```

## Camadas e fluxo de uma requisição

**REST** (ex.: `POST /channels/{id}/messages/history`):
`Caddy → Axum router → middleware auth (valida Bearer, injeta UserId no
request extension) → handler em rest/*.rs → db/*.rs (SQLx) → resposta JSON`.

**WebSocket** (ex.: `chat.message.create`):
`Caddy (upgrade) → Axum ws::WebSocketUpgrade → ws::hub registra a conexão
(após auth.hello bem-sucedido) → cada mensagem recebida é desserializada
para Envelope → despachada ao handler do namespace correspondente em
ws/handlers/ → handler persiste via db/*.rs se aplicável → hub faz
broadcast do envelope de resultado às conexões relevantes (ex.: todos no
mesmo canal, ou todos na mesma call)`.

## O hub de WebSocket

Uma conexão WS vira ativa só depois de um `auth.hello` válido (`WS-FR-001`).
O hub mantém, no mínimo:

```rust
struct ConnectionEntry {
    conn_id: WsConnId,        // UUID gerado ao aceitar a conexão TCP/WS
    user_id: UserId,          // preenchido após auth.hello
    sender: mpsc::UnboundedSender<Message>, // canal para enviar frames a essa conexão
}
struct WsHub {
    connections: DashMap<WsConnId, ConnectionEntry>,
    by_user: DashMap<UserId, HashSet<WsConnId>>, // um usuário pode ter >1 conexão (multi-dispositivo futuro; v1: tipicamente 1)
}
```

Broadcast para "todos os membros da comunidade" (presença, chat) itera
`by_user`; broadcast para "todos os participantes de uma call" consulta o
`CallRegistry` para a lista de `UserId` da call e então resolve para
conexões via `by_user`. Uma mensagem nunca é entregue "às cegas" — sempre
passa pela checagem de autorização do `call::authz` antes do broadcast
(`CALL-FR-006`).

## `CallRegistry` — a estrutura de estado concorrente central

```rust
struct CallRegistry { calls: HashMap<ChannelId, ActiveCall> } // protegido por RwLock async
struct ActiveCall {
    channel_id: ChannelId,
    participants: HashMap<UserId, ParticipantState>,
    streams: HashMap<StreamId, PublishedStream>,
}
struct ParticipantState { user_id: UserId, joined_at: DateTime<Utc>, muted: bool, deafened: bool, connection_id: WsConnId }
struct PublishedStream {
    id: StreamId, owner: UserId, kind: StreamKind, call_id: CallId,
    metadata: StreamMetadata, viewers: HashSet<UserId>,
}
```

Regras de acesso concorrente:
- O `CallRegistry` inteiro é protegido por um `tokio::sync::RwLock`. Leituras
  (ex.: checar se um usuário é participante antes de rotear `rtc.ice`) usam
  o lock de leitura; mutações (join/leave/publish/subscribe) tomam o lock
  de escrita. Dado o volume (≤10 usuários, ≤4 por call), contenção nunca é
  uma preocupação de performance real — a prioridade é correção, não
  throughput.
- Toda mutação é uma função que recebe o estado atual e retorna
  `Result<MutationEffect, CallError>` — nunca há `unwrap()`/`panic!()` em
  um caminho alcançável por input de rede; erros viram `CallError` tipado,
  que o handler WS converte em envelope `error` (`CALL-FR-006`).
- `MutationEffect` descreve o que precisa ser transmitido depois (ex.:
  `ParticipantJoined { channel_id, user_id }` → o handler WS decide para
  quem fazer broadcast). Isso mantém a lógica de negócio pura/testável
  separada do código de I/O de rede.

Nunca é persistido em Postgres (`DB-FR-002`) — um restart do processo
zera todas as calls ativas; clientes detectam a queda de WS e, ao
reconectar, recriam sua participação via `call.join` novamente (o app do
lado cliente decide se re-entra automaticamente ou pede confirmação — ver
`18-ux-spec.md`).

## Autorização de sinalização (`call::authz`)

Toda operação de sinalização (`rtc.offer/answer/ice`, `stream.subscribe/
unsubscribe`) passa por checagens explícitas antes de qualquer efeito:

1. O remetente (`from_user`, extraído da conexão autenticada, nunca do
   payload) é participante da call referenciada.
2. Para mensagens direcionadas (`to_user`), o alvo também é participante da
   mesma call.
3. Para operações de stream, o `streamId` referenciado existe no
   `CallRegistry` e (quando aplicável) pertence de fato ao `owner` alegado.

Falha em qualquer checagem → envelope `error` tipado (`code` estável, ver
`20-error-handling.md`) devolvido ao remetente; nunca um panic, nunca um
fechamento silencioso de conexão.

## Emissão de credenciais TURN

`turn::credentials` gera, sob demanda (tipicamente no momento de
`call.join`), um par usuário/senha TURN de curta duração via HMAC-SHA1
sobre um timestamp de expiração e o shared secret configurado no coturn —
o padrão "TURN REST API" (`RTC-FR-006`, detalhado em `16-security.md`).
Essas credenciais nunca são armazenadas em banco — são computadas e
descartadas.

## Bootstrap do owner

`server --bootstrap-owner` é um comando de CLI separado do binário normal
de servir requisições — cria a única linha em `communities`, o usuário
owner e sua senha (via prompt interativo, nunca argumento de linha de
comando em texto plano) diretamente no banco, sem passar pela API HTTP
(`AUTH-FR-006`). É o único caminho para criar o primeiro usuário; todos os
demais entram por convite (`AUTH-FR-005`).
