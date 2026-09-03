# SPEC-006 — Testes de integração de voz no servidor

## 1. Problema

Não existe **nenhum** teste de `voice.*`, do webhook ou do reconcile
(`server/tests/` cobre auth, chat, presença, anexos, atividade e música; o
único teste do registry são os quatro unitários de
`server/src/ws/call_registry.rs:584-649`).

Toda a Fase A do rollout depende de mudar exatamente a parte do sistema que não
tem cobertura. Sem esta spec, a única verificação das specs 003 a 005 seria
manual, o que não escala e não protege contra regressão futura.

**Causa raiz que endereça:** nenhuma diretamente. Protege as correções de
RC-01 a RC-07 contra regressão, que é o objetivo declarado da restrição 7 do
pedido ("priorize melhorias que reduzam a chance de bugs de concorrência
voltarem").

## 2. Prioridade e dependências

- **Prioridade:** P0
- **Dependências:** SPEC-003, SPEC-004, SPEC-005 (é o teste delas).

Nota de ordem: as specs 003 a 005 já pedem testes específicos. Esta spec
existe para construir a **infraestrutura** de teste que elas usam e para
fechar a cobertura. Na prática, o executor implementa o harness (§4.1 e §4.2)
junto com SPEC-004, porque SPEC-004 não é verificável sem ele. Esta spec é o
registro do que precisa existir ao final e a lista completa de casos.

## 3. Arquivos afetados

| Arquivo | Ação |
|---|---|
| `server/tests/common/mod.rs` | editar: `send_webhook`, `with_fake_livekit`, `WsClient` estendido |
| `server/tests/common/fake_livekit.rs` | criar |
| `server/tests/voice_test.rs` | criar/completar |
| `server/src/config.rs` | editar: `ws_offline_grace_seconds` |
| `server/Cargo.toml` | editar: dev-dependencies |
| `.github/workflows/deploy-production.yml` | editar: rodar testes de `client/ui` |

## 4. Mudança especificada

### 4.1 Fake LiveKit (`server/tests/common/fake_livekit.rs`)

Um servidor HTTP local que implementa as duas rotas Twirp que o servidor usa
(`server/src/livekit.rs:331` e `:344`), com estado controlado pelo teste.

```rust
//! Substituto do livekit-server para testes de integração. Implementa apenas
//! ListRooms e ListParticipants, que é tudo que o reconcile consome.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::{extract::State, routing::post, Json, Router};

#[derive(Clone, Debug, Default)]
pub struct FakeParticipant {
    pub identity: String,
    pub sid: String,
    pub hidden: bool,
    pub state: Option<String>,
    /// (track_sid, source, muted)
    pub tracks: Vec<(String, String, bool)>,
}

#[derive(Clone, Default)]
pub struct FakeLiveKit {
    rooms: Arc<Mutex<HashMap<String, Vec<FakeParticipant>>>>,
    /// Quando `true`, toda chamada responde 500 (para testar degradação).
    failing: Arc<Mutex<bool>>,
}

impl FakeLiveKit {
    /// Sobe em porta efêmera e devolve (instância, url http).
    pub async fn spawn() -> (Self, String) { /* ... */ }

    pub fn set_room(&self, room: &str, participants: Vec<FakeParticipant>);
    pub fn clear_room(&self, room: &str);
    pub fn set_failing(&self, failing: bool);
    /// Quantas vezes ListParticipants foi chamado para um room.
    pub fn list_participants_calls(&self, room: &str) -> usize;
}
```

As respostas precisam ter exatamente a forma que os structs de
`server/src/livekit.rs` desserializam:

```json
// ListRooms
{ "rooms": [ { "name": "<uuid do canal>", "sid": "RM_x" } ] }

// ListParticipants
{ "participants": [
  { "identity": "<uuid do user>", "sid": "PA_x", "state": "ACTIVE",
    "permission": { "hidden": false, "canPublish": true },
    "tracks": [ { "sid": "TR_x", "source": "SCREEN_SHARE", "muted": false } ] }
] }
```

Atenção ao `source`: o LiveKit devolve em maiúsculas (`"SCREEN_SHARE"`) no
`ListParticipants`, e o código atual já normaliza com `to_ascii_uppercase`
(`server/src/livekit.rs:364`). SPEC-004 muda para `to_ascii_lowercase` e
`TrackSource::parse`; o fake deve emitir **maiúsculas**, como o real, para que
o teste exercite a normalização de verdade.

`remove_participant` (`server/src/livekit.rs:272`) também é chamado pelo
servidor. O fake precisa aceitar
`/twirp/livekit.RoomService/RemoveParticipant`, remover o participante do
estado e devolver `{}`, para que I-19 possa verificar o comportamento.

### 4.2 `TestApp` estendido

```rust
impl TestApp {
    /// Sobe o app com um LiveKit falso já apontado.
    pub async fn spawn_with_livekit() -> (Self, FakeLiveKit) { /* ... */ }

    /// Envia um webhook assinado como o LiveKit assina.
    pub async fn send_webhook(&self, event: serde_json::Value) -> reqwest::StatusCode { /* ... */ }

    /// Atalhos que montam o corpo correto de cada evento.
    pub async fn webhook_participant_joined(&self, room: Uuid, user: Uuid, sid: &str) -> reqwest::StatusCode;
    pub async fn webhook_participant_left(&self, room: Uuid, user: Uuid, sid: &str) -> reqwest::StatusCode;
    pub async fn webhook_track_published(&self, room: Uuid, user: Uuid, psid: &str, tsid: &str, source: &str) -> reqwest::StatusCode;
    pub async fn webhook_track_unpublished(&self, room: Uuid, user: Uuid, psid: &str, tsid: &str, source: &str) -> reqwest::StatusCode;
    pub async fn webhook_room_finished(&self, room: Uuid) -> reqwest::StatusCode;

    /// Força um ciclo de reconcile sem esperar o timer.
    pub async fn force_reconcile(&self);
    /// Estado atual do registry, sem passar pelo endpoint HTTP.
    pub async fn voice_snapshot(&self, channel_id: Uuid) -> Option<serde_json::Value>;
}
```

`force_reconcile` exige que `AppState` seja acessível pelo teste. O `TestApp`
já guarda `pool` e `http_url`; adicionar o `AppState` como campo público, o
que também simplifica asserções sobre métricas.

Assinatura do webhook (replica `server/src/livekit.rs:224-240`):

```rust
fn sign_webhook(body: &str, api_key: &str, api_secret: &str) -> String {
    use base64::{engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}, Engine as _};
    use hmac::{Hmac, Mac};
    use sha2::{Digest, Sha256};
    let hash = STANDARD.encode(Sha256::digest(body.as_bytes()));
    let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
    let claims = serde_json::json!({ "iss": api_key, "sha256": hash });
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
    let signing_input = format!("{header}.{payload}");
    let mut mac = Hmac::<Sha256>::new_from_slice(api_secret.as_bytes()).unwrap();
    mac.update(signing_input.as_bytes());
    format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}
```

`verify_webhook` não valida `exp` (leia `server/src/livekit.rs:235-238`: só
confere `iss` e `sha256`), então o teste não precisa forjar expiração.

### 4.3 `WsClient` estendido

```rust
impl WsClient {
    /// auth.hello com campos extras (protocol_version etc.).
    pub async fn connect_and_authenticate_with(ws_url: &str, token: &str, extra: serde_json::Value) -> Self;
    /// Fecha o socket sem frame de Close, simulando queda de rede.
    pub fn terminate(self);
    /// Espera um op com predicado, com timeout.
    pub async fn recv_matching_op(&mut self, op: &str, predicate: impl Fn(&serde_json::Value) -> bool, timeout: Duration) -> Option<serde_json::Value>;
    /// Garante que um op NÃO chega dentro do prazo.
    pub async fn expect_no_op(&mut self, op: &str, within: Duration) -> bool;
}
```

`expect_no_op` é essencial para os testes I-13 e I-14 (um cliente v1 não pode
receber `voice.room.delta`) e para I-02.

### 4.4 Grace configurável

`server/src/config.rs`:

```rust
/// Segundos entre a queda do último socket e a marcação de offline.
/// Configurável só para que os testes não precisem esperar 8 s reais.
pub ws_offline_grace_seconds: u64,
// from_env: env::var("WS_OFFLINE_GRACE_SECONDS").ok().and_then(|v| v.parse().ok()).unwrap_or(8),
```

Substituir o `Duration::from_secs(8)` literal de `handler.rs:222`.

Os testes de presença existentes (`server/tests/presence_test.rs:41-57`)
dependem do valor 8 e das esperas de 2 e 9 s. Manter o default em 8 preserva
esses testes sem alteração.

### 4.5 CI

`.github/workflows/deploy-production.yml`, no job `validate`, adicionar após o
passo do music bot:

```yaml
      - name: Build and test web UI
        working-directory: client/ui
        run: |
          npm ci
          npm run build
          npm test
```

Hoje `client/ui` só é compilado em `release-windows-client.yml`, o que
significa que um erro de tipo em `App.tsx` só aparece na hora de gerar a
release. Como as specs 007 a 014 mexem pesado no cliente, isso precisa mudar
antes.

## 5. Contratos de dados

Nenhum novo. Os testes verificam os contratos de `05-protocol-spec.md`.

## 6. Casos de borda a tratar

1. Porta efêmera do fake LiveKit: usar `TcpListener::bind("127.0.0.1:0")` e ler
   a porta real, como o `TestApp` já faz.
2. Testes em paralelo: `cargo test` roda em paralelo por padrão e o `TestApp`
   já cria um banco por teste (`common/mod.rs:44`). O fake LiveKit precisa ser
   um por teste também, nunca compartilhado.
3. `serial_test` já está nas dev-dependencies (`server/Cargo.toml`); usar
   `#[serial]` apenas nos testes que dependem do timer global de reconcile.
   Preferir `force_reconcile` a esperar o timer, para não precisar de `serial`.
4. Timeouts: todo `recv_matching_op` precisa de timeout explícito; nunca
   esperar indefinidamente, ou uma regressão trava o CI.
5. O fake precisa responder a `ListRooms` mesmo com zero salas
   (`{"rooms": []}`), porque `reconcile_prune` depende disso para remover
   salas mortas.
6. `serde` do corpo Twirp: o LiveKit usa Twirp sobre JSON; o `Content-Type` é
   `application/json` e o corpo da requisição é `{}` ou `{"room": "..."}`.
   O fake pode ignorar o corpo de `ListRooms` e ler apenas `room` no
   `ListParticipants`.

## 7. Critérios de aceite

- **Dado** `cargo test --locked` em uma máquina limpa com Postgres, **então**
  todos os testes de `voice_test.rs` passam em menos de 90 s no total.
- **Dado** o conjunto completo, **então** cobre os 21 casos I-01 a I-21 de
  `07-test-plan.md` §3.
- **Dado** um teste qualquer, **então** ele não depende de `sleep` maior que
  3 s (usar `force_reconcile` e grace configurável).
- **Dado** o job `validate` do CI, **então** ele falha se `npm run build` de
  `client/ui` falhar.
- **Dado** que uma das correções de SPEC-003 a 005 for revertida, **então**
  pelo menos um teste falha. Verificar isto na prática: reverter localmente
  a mudança de INV-A3 e confirmar que I-02 fica vermelho.

O último critério é o mais importante. Um teste que passa com e sem a correção
não protege nada.

## 8. Como testar

Meta-teste, feito uma vez pelo executor ao terminar a spec:

1. Comentar a remoção do evict de SPEC-005 (restaurar `evict_voice_participant`
   no caminho de desconexão). Rodar `cargo test`. **I-02 precisa falhar.**
   Restaurar.
2. Trocar `webhook_participant_left` para ignorar a comparação de sid. Rodar.
   **I-06 precisa falhar.** Restaurar.
3. Restaurar `clear_channel` no `room_finished`. Rodar. **I-10 precisa
   falhar.** Restaurar.
4. Trocar o `stream_id` v5 por `Uuid::new_v4()`. Rodar. **I-15 precisa
   falhar.** Restaurar.

Registrar o resultado dos quatro no PR.

## 9. Riscos e rollback

| Risco | Mitigação |
|---|---|
| Testes lentos travam o CI | Grace configurável, `force_reconcile`, timeouts explícitos |
| Testes instáveis por corrida | Nada de `sleep` para sincronizar; sempre `recv_matching_op` com predicado |
| O fake diverge do LiveKit real | O harness `integration/sfu` (SPEC-017) roda contra o LiveKit de verdade e é o contrapeso |
| `npm ci` no CI aumenta o tempo do job | Cache de npm já é usado no outro workflow; replicar com `actions/setup-node` e `cache: npm` |

**Rollback:** `git revert`. Só testes e infra de teste.

## 10. Fora de escopo

- Não testar mídia real (áudio, vídeo): isso é `integration/sfu` (SPEC-017) e
  roteiro manual.
- Não escrever testes de cliente (vão junto de cada spec de cliente).
- Não mudar os testes existentes de auth, chat, presença, anexos e música.
- Não adicionar LiveKit real ao CI.
