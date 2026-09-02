# SPEC-002 — Observabilidade do servidor de voz

## 1. Problema

**Causa raiz:** RC-13 (não existe observabilidade de voz: nem log estruturado,
nem métrica, nem estado inspecionável).

`server/src/routes/livekit.rs` não tem uma única linha de `tracing`. Não há
como saber o que o servidor achava do estado quando um usuário relata
"sumiu todo mundo". Toda a análise de causa raiz deste plano teve que ser feita
por leitura de código, porque não havia dado nenhum.

Esta spec vem **antes** das correções para que o efeito das correções seja
mensurável. Instrumentar depois de corrigir impede comparar antes e depois.

**Sintomas que desaparecem:** nenhum diretamente. Torna os demais
diagnosticáveis, e é o que permite verificar os critérios de promoção de fase
(`08-rollout-plan.md` §6).

## 2. Prioridade e dependências

- **Prioridade:** P0
- **Dependências:** SPEC-001 (usa `Hub::connection_meta`).

## 3. Arquivos afetados

| Arquivo | Ação |
|---|---|
| `server/src/ws/voice_metrics.rs` | criar |
| `server/src/ws/mod.rs` | editar: declarar o módulo |
| `server/src/state.rs` | editar: `AppState` ganha `voice_metrics` |
| `server/src/routes/livekit.rs` | editar: logar todo webhook |
| `server/src/ws/handler.rs` | editar: logar reconcile, presença e token |
| `server/src/routes/debug.rs` | criar |
| `server/src/routes/mod.rs` | editar: registrar a rota |
| `server/src/db.rs` | editar: helper `channel_names_for` |
| `server/tests/voice_test.rs` | editar: testes do endpoint |

## 4. Mudança especificada

### 4.1 `server/src/ws/voice_metrics.rs` (novo)

```rust
//! Contadores em memória do caminho de voz. Substituem uma stack de métricas
//! completa, que não caberia na VM de 2 GB — ver
//! tupi-v2-refactor/09-alternatives-rejected.md §10.

use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Default)]
pub struct VoiceMetrics {
    pub webhooks_received: AtomicU64,
    pub webhooks_rejected: AtomicU64,
    pub webhooks_ignored_stale: AtomicU64,
    pub webhooks_ignored_duplicate: AtomicU64,
    pub webhooks_ignored_hidden: AtomicU64,
    pub reconciles_run: AtomicU64,
    pub reconciles_with_drift: AtomicU64,
    pub reconciles_failed: AtomicU64,
    pub participants_added_by_webhook: AtomicU64,
    pub participants_added_by_reconcile: AtomicU64,
    pub participants_removed_by_webhook: AtomicU64,
    pub participants_removed_by_reconcile: AtomicU64,
    pub provisional_created: AtomicU64,
    pub provisional_confirmed: AtomicU64,
    pub provisional_expired: AtomicU64,
    pub deltas_sent: AtomicU64,
    pub snapshots_sent: AtomicU64,
    pub version_gaps_reported: AtomicU64,
    pub tokens_issued: AtomicU64,
    pub tokens_refused: AtomicU64,
    pub last_reconcile_duration_ms: AtomicU64,
    pub last_reconcile_at_unix: AtomicU64,
}

impl VoiceMetrics {
    pub fn bump(counter: &AtomicU64) { counter.fetch_add(1, Ordering::Relaxed); }
    pub fn bump_by(counter: &AtomicU64, amount: u64) { counter.fetch_add(amount, Ordering::Relaxed); }
    pub fn set(counter: &AtomicU64, value: u64) { counter.store(value, Ordering::Relaxed); }
    pub fn get(counter: &AtomicU64) -> u64 { counter.load(Ordering::Relaxed) }

    /// Snapshot serializável para GET /api/debug/voice.
    pub fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "webhooks_received": Self::get(&self.webhooks_received),
            "webhooks_rejected": Self::get(&self.webhooks_rejected),
            "webhooks_ignored_stale": Self::get(&self.webhooks_ignored_stale),
            "webhooks_ignored_duplicate": Self::get(&self.webhooks_ignored_duplicate),
            "webhooks_ignored_hidden": Self::get(&self.webhooks_ignored_hidden),
            "reconciles_run": Self::get(&self.reconciles_run),
            "reconciles_with_drift": Self::get(&self.reconciles_with_drift),
            "reconciles_failed": Self::get(&self.reconciles_failed),
            "participants_added_by_webhook": Self::get(&self.participants_added_by_webhook),
            "participants_added_by_reconcile": Self::get(&self.participants_added_by_reconcile),
            "participants_removed_by_webhook": Self::get(&self.participants_removed_by_webhook),
            "participants_removed_by_reconcile": Self::get(&self.participants_removed_by_reconcile),
            "provisional_created": Self::get(&self.provisional_created),
            "provisional_confirmed": Self::get(&self.provisional_confirmed),
            "provisional_expired": Self::get(&self.provisional_expired),
            "deltas_sent": Self::get(&self.deltas_sent),
            "snapshots_sent": Self::get(&self.snapshots_sent),
            "version_gaps_reported": Self::get(&self.version_gaps_reported),
            "tokens_issued": Self::get(&self.tokens_issued),
            "tokens_refused": Self::get(&self.tokens_refused),
            "last_reconcile_duration_ms": Self::get(&self.last_reconcile_duration_ms),
            "last_reconcile_at_unix": Self::get(&self.last_reconcile_at_unix),
        })
    }
}
```

Contadores de estados que ainda não existem (provisional, deltas, drift) são
criados aqui e ficam em zero até SPEC-003 e SPEC-005 os incrementarem. Isso é
intencional: o endpoint não muda de forma entre specs.

### 4.2 `server/src/state.rs`

```rust
pub struct AppState {
    // ... campos existentes ...
    pub voice_metrics: Arc<crate::ws::voice_metrics::VoiceMetrics>,
    /// Instante do boot, para o `uptime_seconds` do endpoint de debug.
    pub started_at: Instant,
}
```

Inicializar em `AppState::new` (hoje `state.rs:464`) com
`Arc::new(VoiceMetrics::default())` e `Instant::now()`.

### 4.3 `server/src/routes/livekit.rs` — logar todo webhook

Reescrever `webhook` (hoje `livekit.rs:41-58`) mantendo o comportamento atual
**inalterado**, apenas adicionando log e contadores. Esta spec não muda
semântica; SPEC-004 é quem muda.

```rust
pub async fn webhook(State(state): State<AppState>, headers: HeaderMap, body: String) -> AppResult<()> {
    VoiceMetrics::bump(&state.voice_metrics.webhooks_received);
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| {
            VoiceMetrics::bump(&state.voice_metrics.webhooks_rejected);
            tracing::warn!(event = "voice.webhook.rejected", reason = "missing_authorization");
            AppError::Unauthorized
        })?;
    let event = livekit::verify_webhook(&state.config, authorization, &body).map_err(|error| {
        VoiceMetrics::bump(&state.voice_metrics.webhooks_rejected);
        tracing::warn!(event = "voice.webhook.rejected", reason = "signature", %error);
        AppError::Unauthorized
    })?;

    let room_name = event.room.as_ref().map(|r| r.name.clone());
    let identity = event.participant.as_ref().map(|p| p.identity.clone());
    tracing::debug!(
        event = "voice.webhook.received",
        livekit_event = %event.event,
        room = room_name.as_deref().unwrap_or("-"),
        identity = identity.as_deref().unwrap_or("-"),
        track_source = event.track.as_ref().map(|t| t.source.as_str()).unwrap_or("-"),
    );

    let Some(room) = event.room.and_then(|room| Uuid::parse_str(&room.name).ok()) else {
        tracing::info!(
            event = "voice.webhook.ignored",
            outcome = "unparsable_room",
            livekit_event = %event.event,
            room = room_name.as_deref().unwrap_or("-"),
        );
        return Ok(());
    };
    let participant = event.participant.and_then(|p| Uuid::parse_str(&p.identity).ok());

    // ... o match existente, inalterado, com um tracing::info! por braço ...
}
```

Cada braço do `match` ganha um log com `event`, `channel_id`, `user_id` e
`outcome: "applied"`. O braço `_ =>` passa a logar
`event = "voice.webhook.ignored", outcome = "unhandled_event"`.

Em `token` (hoje `livekit.rs:20-33`), adicionar antes do `Ok(...)`:

```rust
VoiceMetrics::bump(&state.voice_metrics.tokens_issued);
tracing::info!(
    event = "voice.token.issued",
    channel_id = %request.channel_id,
    user_id = %identity,
    mode = ?request.mode,
    is_bot,
);
```

E nos três caminhos de recusa (`channel.kind != "voice"`,
`channel_if_member` vazio, `livekit_url` ausente), incrementar
`tokens_refused` e logar `voice.token.refused` com o motivo.

### 4.4 `server/src/ws/handler.rs` — logar reconcile e presença

Em `reconcile_voice_rooms` (hoje `handler.rs:1296-1329`):

```rust
pub async fn reconcile_voice_rooms(state: &AppState) {
    if state.config.livekit_url.is_none() { return; }
    let started = std::time::Instant::now();
    VoiceMetrics::bump(&state.voice_metrics.reconciles_run);
    tracing::debug!(event = "voice.reconcile.started");

    let snapshot = match crate::livekit::room_snapshot(&state.config).await {
        Ok(rooms) => rooms,
        Err(error) => {
            VoiceMetrics::bump(&state.voice_metrics.reconciles_failed);
            tracing::warn!(event = "voice.reconcile.failed", %error);
            return;
        }
    };
    let rooms_queried = snapshot.len();
    // ... mapeamento existente ...
    let changed = state.hub.calls.write().await.reconcile(mapped);
    let duration_ms = started.elapsed().as_millis() as u64;
    VoiceMetrics::set(&state.voice_metrics.last_reconcile_duration_ms, duration_ms);
    VoiceMetrics::set(
        &state.voice_metrics.last_reconcile_at_unix,
        chrono::Utc::now().timestamp().max(0) as u64,
    );
    if changed.is_empty() {
        tracing::debug!(event = "voice.reconcile.completed", rooms_queried, rooms_changed = 0, duration_ms);
    } else {
        VoiceMetrics::bump(&state.voice_metrics.reconciles_with_drift);
        tracing::warn!(
            event = "voice.reconcile.drift_detected",
            rooms_queried,
            rooms_changed = changed.len(),
            channels = ?changed,
            duration_ms,
            "reconcile encontrou divergência; um webhook foi perdido ou houve corrida"
        );
    }
    for channel_id in changed { broadcast_voice_roster(state, channel_id).await; }
}
```

`voice.reconcile.drift_detected` em nível `warn` é deliberado: em regime
saudável ele deve ser raro, e a frequência dele é a métrica de saúde número um
(`06-observability.md` §1.2).

Em `voice.presence.enter` (hoje `handler.rs:553-583`) e `voice.presence.leave`
(`:584-593`), adicionar `tracing::info!` com `event`, `channel_id`, `user_id`,
`source = "ws"`, `outcome`.

Em `evict_voice_participant` (`handler.rs:1240`), adicionar log com o `source`
recebido como parâmetro novo:

```rust
pub(crate) async fn evict_voice_participant(
    state: &AppState,
    channel_id: Uuid,
    user_id: Uuid,
    source: &'static str,
) {
    tracing::info!(
        event = "voice.registry.participant_removed",
        %channel_id, %user_id, source, outcome = "applied"
    );
    // ... corpo existente ...
}
```

Atualizar as três chamadas existentes (`handler.rs:235`, `:572`, `:592`,
`:1510`) passando `"ws_disconnect"`, `"ws_channel_switch"`, `"ws_leave"` e
`"admin_disconnect"`.

### 4.5 `server/src/routes/debug.rs` (novo)

```rust
//! Inspeção de estado em produção sem redeploy (INV-G2).
//! Restrito ao owner da comunidade: expõe identidades e versões de cliente.

use axum::{extract::{Query, State}, Json};
use serde::Deserialize;

use crate::{auth::AuthUser, db, error::{AppError, AppResult}, state::AppState};

#[derive(Debug, Deserialize)]
pub struct DebugQuery {
    /// `live=1` consulta o LiveKit e devolve a diferença contra o registry.
    #[serde(default)]
    pub live: Option<u8>,
}

pub async fn voice(
    State(state): State<AppState>,
    auth: AuthUser,
    Query(query): Query<DebugQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let community_id = db::primary_community_for(&state.pool, auth.user.id)
        .await?
        .ok_or(AppError::Forbidden)?;
    if !matches!(db::is_community_owner(&state.pool, community_id, auth.user.id).await, Ok(true)) {
        return Err(AppError::Forbidden);
    }
    // ... montagem do corpo definido em 06-observability.md §4 ...
}
```

O extrator `AuthUser` já existe (`server/src/auth.rs:104`, com
`impl FromRequestParts` em `:110`) e é usado exatamente assim em
`server/src/routes/profile.rs:44`. Usar esse; não criar extrator novo.

`db::primary_community_for` já existe de forma inline em
`handler.rs:524` (a query `SELECT community_id FROM community_members WHERE user_id = $1 LIMIT 1`).
Extrair essa query para `server/src/db.rs` como função nomeada e usar nos dois
lugares.

Rate limit do modo `live`: reusar o padrão de
`AppState::should_reconcile_voice` (`state.rs:480`), com um `Mutex<Option<Instant>>`
novo chamado `last_debug_live` e janela de 10 s. Excedente devolve o corpo sem
o bloco `livekit_diff` e com `"live_skipped": "rate_limited"`.

O bloco de diferença compara, por canal: participantes só no LiveKit,
participantes só no registry, tracks só no LiveKit, tracks só no registry.

### 4.6 `server/src/routes/mod.rs`

```rust
.route("/api/debug/voice", get(debug::voice))
```

## 5. Contratos de dados

Corpo de `GET /api/debug/voice` definido em `06-observability.md` §4. Campos
adicionais do modo `live`:

```json
{
  "livekit_diff": {
    "queried_at": "2026-09-02T18:10:00Z",
    "rooms": [
      {
        "channel_id": "<uuid>",
        "only_in_livekit": { "participants": ["<uuid>"], "tracks": ["TR_x"] },
        "only_in_registry": { "participants": ["<uuid>"], "tracks": ["TR_y"] }
      }
    ]
  }
}
```

Um `livekit_diff.rooms` vazio significa que servidor e SFU concordam
integralmente. É o resultado esperado em regime saudável.

## 6. Casos de borda a tratar

1. Usuário não pertence a nenhuma comunidade: `403`, não `500`.
2. Usuário é membro mas não owner: `403`.
3. `live=1` com LiveKit indisponível: devolver o corpo normal mais
   `"livekit_diff": null` e `"live_error": "<mensagem>"`. Nunca `500`.
4. `live=1` chamado duas vezes em 3 s: a segunda vem sem `livekit_diff` e com
   `"live_skipped": "rate_limited"`.
5. Registry vazio: `rooms: []`, não `null`.
6. Canal presente no registry mas apagado do banco: incluir com
   `channel_name: null`, não omitir. Um canal órfão no registry é exatamente o
   tipo de bug que este endpoint existe para revelar.
7. Contadores em overflow de `u64`: impossível na prática; não tratar.
8. Serialização de `Instant`: converter para milissegundos decorridos
   (`reconciled_at_ago_ms`), nunca serializar `Instant` diretamente.

## 7. Critérios de aceite

- **Dado** um owner autenticado, **quando** chama `GET /api/debug/voice`,
  **então** recebe `200` com `server_version`, `uptime_seconds`, `metrics`,
  `rooms` e `connections`.
- **Dado** um membro não-owner, **então** recebe `403`.
- **Dado** que dois clientes estão conectados com versões 1 e 2, **quando** o
  owner consulta o endpoint, **então** `connections` lista as duas com
  `protocol_version` correto.
- **Dado** um webhook com assinatura inválida, **então** existe um log com
  `event: "voice.webhook.rejected"` e `webhooks_rejected` incrementou.
- **Dado** um reconcile que não muda nada, **então** o log é `debug` com
  `rooms_changed: 0` e `reconciles_with_drift` **não** incrementa.
- **Dado** um reconcile que muda algo, **então** existe um log `warn` com
  `event: "voice.reconcile.drift_detected"` listando os canais.
- **Dado** `live=1` com o LiveKit fora do ar, **então** a resposta é `200` com
  `livekit_diff: null` e `live_error` preenchido.
- **Dado** qualquer log emitido por esta spec, **então** ele não contém token,
  JWT nem senha.

## 8. Como testar

### Automatizado (`server/tests/voice_test.rs`)

| Teste | Verifica |
|---|---|
| `debug_endpoint_requires_owner` | `403` para membro comum |
| `debug_endpoint_lists_connection_versions` | duas conexões, versões distintas |
| `debug_endpoint_survives_livekit_being_down` | `live=1` sem LiveKit devolve `200` |
| `debug_endpoint_reports_orphan_channel` | canal no registry sem linha no banco aparece com `channel_name: null` |

### Manual

1. `dev.cmd`, entrar em um canal com dois clientes.
2. `curl -H "Authorization: Bearer <token do owner>" http://127.0.0.1:8090/api/debug/voice`
   e conferir que os dois aparecem.
3. `...?live=1` e conferir `livekit_diff.rooms` vazio.
4. Parar o container do LiveKit e repetir: resposta `200` com `live_error`.
5. Conferir no log do servidor que um `voice.reconcile.drift_detected` aparece
   ao matar o LiveKit e voltar.

## 9. Riscos e rollback

| Risco | Mitigação |
|---|---|
| O endpoint expõe identidades a quem não deveria | Restrito a owner; a comunidade tem um owner só |
| `live=1` sobrecarrega o LiveKit | Rate limit de 10 s |
| Volume de log cresce demais na VM de 2 GB | SPEC-016 configura `max-size: 10m` e `max-file: 3` por serviço; até lá, os níveis `debug` só saem com `RUST_LOG=debug` |
| Contadores atômicos custam performance | `Ordering::Relaxed` em contador é essencialmente grátis |

**Rollback:** `git revert`. A spec é puramente aditiva; nenhum comportamento
existente muda.

## 10. Fora de escopo

- Não mudar nenhuma semântica de webhook, reconcile ou registry. Só instrumentar.
- Não adicionar Prometheus, Grafana ou qualquer exportador
  (`09-alternatives-rejected.md` §10).
- Não implementar o endpoint de logs de cliente (SPEC-014).
- Não mudar `server/src/telemetry.rs`; o formato JSON atual já serve.
