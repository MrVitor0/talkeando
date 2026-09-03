# SPEC-001 — Handshake de protocolo v2 e versão do cliente no `auth.hello`

## 1. Problema

**Causa raiz:** RC-14 (não há negociação de versão; o servidor não sabe com qual
cliente fala).

Com auto-update do Velopack, clientes de versões diferentes coexistem por dias.
Nenhuma mudança de protocolo das specs seguintes pode ser feita com segurança
sem que o servidor saiba o dialeto de cada conexão. Esta spec não corrige
sintoma nenhum sozinha: ela é o pré-requisito de todas as outras mudanças de
protocolo (INV-E1, INV-E2, INV-E3).

**Sintoma do usuário que desaparece:** nenhum diretamente. Sem ela, porém, as
specs 003 a 005 quebrariam clientes antigos em produção.

## 2. Prioridade e dependências

- **Prioridade:** P0
- **Dependências:** nenhuma. Esta é a primeira spec a executar.

## 3. Arquivos afetados

| Arquivo | Ação |
|---|---|
| `server/src/ws/protocol.rs` | editar: `AuthHello`, `AuthOk` |
| `server/src/ws/handler.rs` | editar: `handle_socket` guarda a versão negociada |
| `server/src/ws/hub.rs` | editar: `ConnHandle` guarda metadados da conexão |
| `server/src/lib.rs` | editar: expor `SERVER_VERSION` |
| `client/ui/src/ipc.ts` | nenhuma mudança |
| `client/native/Talkeando.Client/NetworkClient.cs` | editar: enviar campos novos no `auth.hello` |
| `server/tests/voice_test.rs` | criar (esqueleto; testes de versão) |

## 4. Mudança especificada

### 4.1 `server/src/ws/protocol.rs`

Substituir `AuthHello` (hoje em `protocol.rs:55-58`) por:

```rust
#[derive(Debug, Deserialize)]
pub struct AuthHello {
    pub token: String,
    #[serde(default = "default_protocol_version")]
    pub protocol_version: u8,
    #[serde(default)]
    pub client_version: Option<String>,
    #[serde(default)]
    pub client_platform: Option<String>,
}

fn default_protocol_version() -> u8 { 1 }
```

Substituir `AuthOk` (hoje em `protocol.rs:60-67`) por:

```rust
#[derive(Debug, Serialize)]
pub struct AuthOk {
    pub user_id: Uuid,
    pub username: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub livekit_url: Option<String>,
    /// Versão de protocolo efetivamente negociada para esta conexão.
    pub protocol_version: u8,
    /// CARGO_PKG_VERSION do servidor.
    pub server_version: String,
    /// Capacidades opcionais; o cliente ignora nomes que não conhece.
    pub features: Vec<String>,
}
```

Adicionar ao mesmo arquivo, no topo da seção `auth.*`:

```rust
/// Maior versão de protocolo que este servidor fala. Incrementar somente
/// junto com uma mudança de dialeto documentada em
/// tupi-v2-refactor/05-protocol-spec.md.
pub const MAX_SERVER_PROTOCOL: u8 = 2;
```

Nesta spec o servidor ainda **não** implementa nada de v2; `MAX_SERVER_PROTOCOL`
fica em `2` desde já porque SPEC-005 é quem passa a emitir as ops novas, e a
lista `features` é que declara o que está realmente disponível. Para não
mentir, nesta spec `features` retorna **vazio**. SPEC-005 adiciona
`"voice.room.v2"` e `"voice.hints"`; SPEC-014 adiciona `"client.logs"`.

Consequência importante: um cliente que negocie `protocol_version: 2` mas veja
`features` vazio **precisa** operar no dialeto v1. O cliente decide pelo
conteúdo de `features`, não pelo número. Isso está normatizado em
`05-protocol-spec.md` §1.2 e é o que permite entregar esta spec sozinha.

### 4.2 `server/src/ws/hub.rs`

Estender `ConnHandle` (hoje em `hub.rs:9-11`):

```rust
pub struct ConnHandle {
    pub tx: mpsc::UnboundedSender<Message>,
    pub meta: ConnMeta,
}

#[derive(Debug, Clone)]
pub struct ConnMeta {
    /// Versão negociada: min(cliente, MAX_SERVER_PROTOCOL).
    pub protocol_version: u8,
    pub client_version: String,
    pub client_platform: String,
    pub connected_at: chrono::DateTime<chrono::Utc>,
}
```

Alterar a assinatura de `register` (hoje `hub.rs:71`):

```rust
pub async fn register(
    &self,
    user_id: Uuid,
    tx: mpsc::UnboundedSender<Message>,
    meta: ConnMeta,
) -> Uuid
```

Adicionar dois métodos novos:

```rust
/// Metadados de todas as conexões vivas. Usado por GET /api/debug/voice
/// (SPEC-002) para responder "quem está em qual versão".
pub async fn connection_meta(&self) -> Vec<(Uuid, ConnMeta)> {
    self.conns
        .read()
        .await
        .iter()
        .flat_map(|(user_id, handles)| {
            handles.values().map(move |handle| (*user_id, handle.meta.clone()))
        })
        .collect()
}

/// Envia `env` apenas para as conexões cuja versão negociada seja >= `min`.
/// É o mecanismo que impede uma op v2 de chegar a um cliente v1.
pub async fn broadcast_to_versioned(
    &self,
    user_ids: &[Uuid],
    min_protocol: u8,
    env: OutboundEnvelope,
) {
    let Ok(text) = serde_json::to_string(&env) else { return; };
    let conns = self.conns.read().await;
    for uid in user_ids {
        if let Some(handles) = conns.get(uid) {
            for handle in handles.values() {
                if handle.meta.protocol_version >= min_protocol {
                    let _ = handle.tx.send(Message::Text(text.clone()));
                }
            }
        }
    }
}
```

Adicionar também a variante de teto, necessária para o inverso (mandar op v1
apenas para quem é v1), usada por SPEC-005:

```rust
pub async fn broadcast_to_max_version(
    &self,
    user_ids: &[Uuid],
    max_protocol: u8,
    env: OutboundEnvelope,
) {
    let Ok(text) = serde_json::to_string(&env) else { return; };
    let conns = self.conns.read().await;
    for uid in user_ids {
        if let Some(handles) = conns.get(uid) {
            for handle in handles.values() {
                if handle.meta.protocol_version <= max_protocol {
                    let _ = handle.tx.send(Message::Text(text.clone()));
                }
            }
        }
    }
}
```

Atualizar os quatro pontos existentes que constroem `ConnHandle { tx }`
(`hub.rs:78`) e as chamadas de `register` (`handler.rs:96`).

### 4.3 `server/src/ws/handler.rs`

No bloco de handshake (hoje `handler.rs:56-76`), capturar os campos novos. O
`match` atual descarta o `AuthHello` depois de ler o token; passar a devolver a
tupla completa:

```rust
// Antes: Option<(db::User, Uuid)>
// Depois: Option<(db::User, Uuid, ConnMeta)>
let hello = tokio::time::timeout(Duration::from_secs(10), receiver.next()).await;
let authenticated = match hello {
    Ok(Some(Ok(Message::Text(text)))) => match serde_json::from_str::<InboundEnvelope>(&text) {
        Ok(env) if env.op == "auth.hello" => {
            match serde_json::from_value::<AuthHello>(env.data) {
                Ok(hello) => {
                    let meta = ConnMeta {
                        protocol_version: hello.protocol_version.min(MAX_SERVER_PROTOCOL),
                        client_version: hello.client_version.clone().unwrap_or_else(|| "unknown".into()),
                        client_platform: hello.client_platform.clone().unwrap_or_else(|| "unknown".into()),
                        connected_at: chrono::Utc::now(),
                    };
                    if hello.token == state.config.music_bot_token {
                        Some((music_bot_user(), Uuid::nil(), meta))
                    } else {
                        match authenticate_token(&state.pool, &hello.token).await {
                            Ok((u, s)) => Some((u, s, meta)),
                            Err(error) => {
                                if !matches!(error, crate::error::AppError::Unauthorized) {
                                    tracing::error!(%error, "database error during ws handshake");
                                }
                                None
                            }
                        }
                    }
                }
                Err(_) => None,
            }
        }
        _ => None,
    },
    _ => None,
};
let Some((user, _session_id, conn_meta)) = authenticated else { /* auth.rejected, igual a hoje */ };
```

Passar `conn_meta.clone()` para `state.hub.register(...)`.

Substituir o log de conexão (hoje `handler.rs:93`) por:

```rust
tracing::info!(
    %user_id,
    protocol_version = conn_meta.protocol_version,
    client_version = %conn_meta.client_version,
    client_platform = %conn_meta.client_platform,
    "ws connected"
);
```

Preencher o `AuthOk` (hoje `handler.rs:105-113`):

```rust
AuthOk {
    user_id,
    username: user.username.clone(),
    display_name: user.display_name.clone(),
    livekit_url: state.config.livekit_url.clone(),
    protocol_version: conn_meta.protocol_version,
    server_version: crate::SERVER_VERSION.to_string(),
    features: crate::ws::server_features(&state.config),
}
```

### 4.4 `server/src/lib.rs`

```rust
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
```

### 4.5 `server/src/ws/mod.rs`

```rust
/// Capacidades que este servidor anuncia no auth.ok. Cada spec que entrega
/// uma capacidade adiciona seu nome aqui, nunca antes.
pub fn server_features(_config: &crate::config::Config) -> Vec<String> {
    Vec::new()
}
```

### 4.6 `client/native/Talkeando.Client/NetworkClient.cs`

Em `ConnectWebSocketAsync` (hoje `NetworkClient.cs:357`), trocar:

```csharp
await SendWebSocketAsync("auth.hello", JsonSerializer.SerializeToElement(new { token }));
```

por:

```csharp
await SendWebSocketAsync("auth.hello", JsonSerializer.SerializeToElement(new
{
    token,
    protocol_version = ClientProtocolVersion,
    client_version = UpdateChecker.GetCurrentVersion(),
    client_platform = "windows",
}));
```

E adicionar como campo da classe:

```csharp
/// Versão do protocolo de sinalização que esta build entende. Incrementar
/// somente junto com uma mudança em tupi-v2-refactor/05-protocol-spec.md.
/// A UI descobre a versão efetivamente negociada pelo auth.ok.
private const int ClientProtocolVersion = 1;
```

Fica em `1` nesta spec. SPEC-008 a promove para `2`, junto com o cliente que de
fato entende as ops novas. Isso é deliberado: anunciar 2 antes de saber falar 2
faria o servidor mandar ops que o cliente ignoraria.

Encaminhar `auth.ok` para a UI: nenhuma mudança é necessária, o
`HandleNetworkEvent` já relaya tudo (`IpcBridge.cs:423`).

## 5. Contratos de dados

Definidos em `05-protocol-spec.md` §1.1 e §1.2. Repetidos aqui apenas no que é
obrigatório validar:

| Campo | Regra de validação |
|---|---|
| `auth.hello.protocol_version` | inteiro 0 a 255; ausente vira `1`; valor maior que `MAX_SERVER_PROTOCOL` é rebaixado, nunca rejeitado |
| `auth.hello.client_version` | string livre, truncar em 64 caracteres antes de guardar |
| `auth.hello.client_platform` | string livre, truncar em 32 caracteres |
| `auth.ok.protocol_version` | sempre presente |
| `auth.ok.features` | array possivelmente vazio, sempre presente |

Truncar é obrigatório: os valores vão para log e para o endpoint de debug, e são
controlados pelo cliente.

## 6. Casos de borda a tratar

1. `auth.hello` sem `protocol_version`: assume 1. **Não** rejeitar.
2. `auth.hello` com `protocol_version: 99`: negocia `2` (o teto do servidor).
3. `auth.hello` com `protocol_version: 0`: negocia `0`; como nenhuma op exige
   versão 0, isso é equivalente a v1 para todos os efeitos. Não tratar como
   erro.
4. `client_version` com 10 000 caracteres: truncar em 64 antes de guardar e
   logar.
5. `client_version` ausente: guardar `"unknown"`, nunca `null`, para que o
   endpoint de debug não precise tratar nulo.
6. Bot de música: autentica pelo `music_bot_token` e não manda
   `protocol_version`; fica em 1. SPEC-015 o promove.
7. Duas conexões do mesmo usuário com versões diferentes (app antigo e app novo
   abertos ao mesmo tempo): cada `ConnHandle` guarda sua própria `meta`, e o
   broadcast versionado resolve por conexão, não por usuário. Este é o motivo de
   `meta` ficar no `ConnHandle` e não em um mapa por usuário.
8. Reconexão: `register` é chamado de novo com `meta` nova; a antiga sai com o
   `unregister` do socket velho.

## 7. Critérios de aceite

- **Dado** um cliente que envia `auth.hello` sem campos novos, **quando** ele
  autentica, **então** o `auth.ok` traz `protocol_version: 1`, `server_version`
  preenchido e `features: []`, e a conexão funciona exatamente como hoje.
- **Dado** um cliente que envia `protocol_version: 2`, **quando** ele autentica,
  **então** o `auth.ok` traz `protocol_version: 2` e `features: []` (nesta
  spec).
- **Dado** um cliente que envia `protocol_version: 99`, **então** o `auth.ok`
  traz `protocol_version: 2`.
- **Dado** um `client_version` com mais de 64 caracteres, **então** o valor
  guardado tem exatamente 64.
- **Dado** dois sockets do mesmo usuário com versões 1 e 2, **quando**
  `connection_meta()` é chamado, **então** devolve duas entradas com versões
  diferentes.
- **Dado** o cliente nativo desta spec, **quando** conecta, **então** o log
  `ws connected` do servidor contém `client_version` igual à versão do assembly.

## 8. Como testar

### Automatizado

Criar `server/tests/voice_test.rs` com:

```rust
mod common;
use common::{TestApp, WsClient};

#[tokio::test]
async fn hello_without_protocol_version_negotiates_v1() { /* ... */ }

#[tokio::test]
async fn hello_with_v2_negotiates_v2_and_reports_features() { /* ... */ }

#[tokio::test]
async fn hello_with_absurd_version_is_clamped_to_server_max() { /* ... */ }

#[tokio::test]
async fn client_version_is_truncated_to_64_chars() { /* ... */ }
```

`WsClient::connect_and_authenticate` (`server/tests/common/mod.rs:243`) hoje
envia só o token. Adicionar uma variante:

```rust
pub async fn connect_and_authenticate_with(
    ws_url: &str,
    token: &str,
    hello_extra: serde_json::Value,
) -> Self
```

que faz o merge de `hello_extra` no objeto de `auth.hello`. Manter a função
antiga chamando a nova com `json!({})`, para não tocar nos testes existentes.

### Manual

1. Rodar `dev.cmd`, abrir um cliente, conferir no log do servidor a linha
   `ws connected` com `client_version` igual à versão do `.csproj`
   (hoje `0.1.0`, `Talkeando.Client.csproj:16`).
2. Conectar com `wscat` ou com o `integration/sfu/run.cjs` enviando
   `protocol_version: 2` e conferir o `auth.ok`.

## 9. Riscos e rollback

| Risco | Mitigação |
|---|---|
| A mudança de assinatura de `register` quebra a compilação em pontos não previstos | O compilador Rust aponta todos; são 1 chamada em `handler.rs:96` e os testes |
| `ConnHandle` maior aumenta memória | `ConnMeta` são ~120 bytes por conexão; com 20 conexões é irrelevante |
| Um cliente malicioso manda `client_version` gigante | Truncado em 64 antes de qualquer uso |

**Rollback:** `git revert` do commit. Nenhuma migração de dados, nenhum estado
persistido, nenhuma mudança de comportamento observável para clientes atuais.

## 10. Fora de escopo

- Não implementar nenhuma op v2 (isso é SPEC-005).
- Não mudar `ClientProtocolVersion` para 2 (isso é SPEC-008).
- Não tocar em `CallRegistry` nem no webhook.
- Não adicionar nada a `features` além de lista vazia.
- Não mexer no fluxo de reconexão do `NetworkClient`.
