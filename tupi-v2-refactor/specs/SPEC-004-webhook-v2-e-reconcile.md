# SPEC-004 — Webhook v2 e reconcile dirigido

## 1. Problema

**Causas raiz:** RC-01 (precedência invertida), RC-04 (`room_finished` apaga o
canal inteiro), RC-06 (webhook sem sid, eventos fora de ordem se cancelam),
RC-07 (espectadores viram participantes), A3 (limite de participantes nunca
aplicado), A10 (webhook sem dedupe nem proteção de replay).

Hoje `server/src/routes/livekit.rs:41-58` decodifica apenas `identity` e
`source`, aplica tudo cegamente, e `room_finished` chama `clear_channel`
(`:53`), apagando um canal que pode ter gente dentro.

**Sintomas que desaparecem:** 1 (fantasmas e sumiços coletivos), parte do 3
(canal que some e volta), parte do 4 (tela que não reaparece).

## 2. Prioridade e dependências

- **Prioridade:** P0
- **Dependências:** SPEC-003 (usa `VoiceRegistry`), SPEC-002 (usa `VoiceMetrics`).

## 3. Arquivos afetados

| Arquivo | Ação |
|---|---|
| `server/src/livekit.rs` | editar: decodificar sid, permission, muted; filtrar ocultos |
| `server/src/routes/livekit.rs` | reescrever `webhook`; adicionar verificação de lotação em `token` |
| `server/src/ws/handler.rs` | editar: `reconcile_voice_rooms` usa `VoiceRegistry`; adicionar reconcile dirigido |
| `server/src/state.rs` | editar: fila de reconcile dirigido |
| `server/src/main.rs` | editar: tick também expira provisórios |
| `server/tests/voice_test.rs` | editar: testes I-01, I-04 a I-11, I-18 |
| `server/tests/common/mod.rs` | editar: `send_webhook` e `with_fake_livekit` |

## 4. Mudança especificada

### 4.1 `server/src/livekit.rs` — decodificar o que hoje é ignorado

Substituir os structs de webhook (hoje `livekit.rs:210-217`):

```rust
#[derive(Debug, Deserialize)]
pub struct WebhookEvent {
    pub event: String,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<i64>,
    pub room: Option<Room>,
    pub participant: Option<Participant>,
    pub track: Option<Track>,
}

#[derive(Debug, Deserialize)]
pub struct Room {
    pub name: String,
    #[serde(default)]
    pub sid: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Participant {
    pub identity: String,
    #[serde(default)]
    pub sid: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub permission: Option<ParticipantPermission>,
}

#[derive(Debug, Deserialize, Clone, Copy, Default)]
pub struct ParticipantPermission {
    #[serde(default)]
    pub hidden: bool,
    #[serde(default, rename = "canPublish")]
    pub can_publish: bool,
}

#[derive(Debug, Deserialize)]
pub struct Track {
    pub source: String,
    #[serde(default)]
    pub sid: Option<String>,
    #[serde(default)]
    pub muted: bool,
}
```

O LiveKit envia o webhook em JSON com nomes em `camelCase` para campos
compostos (`createdAt`, `canPublish`) e `snake_case` para os simples. Os
`rename` acima cobrem os compostos que usamos. Se um campo vier ausente, o
`#[serde(default)]` garante que o parse não falha, o que é o comportamento
exigido por INV-E2.

Estender `ParticipantInfo` do `ListParticipants` (hoje `livekit.rs:306-312`):

```rust
#[derive(Debug, Deserialize)]
struct ParticipantInfo {
    identity: String,
    #[serde(default)]
    sid: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    permission: Option<ParticipantPermission>,
    #[serde(default)]
    tracks: Vec<TrackInfo>,
}

#[derive(Debug, Deserialize)]
struct TrackInfo {
    sid: String,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    muted: bool,
}
```

Substituir `RoomParticipant` (hoje `livekit.rs:283-289`) por uma forma que
carrega as tracks tal como são, sem achatar em `camera_sid` e `screen_sid`:

```rust
#[derive(Debug, Clone)]
pub struct RoomParticipant {
    pub identity: String,
    pub sid: String,
    /// (track_sid, source do LiveKit em minúsculas, muted)
    pub tracks: Vec<(String, String, bool)>,
}
```

Em `room_snapshot` (hoje `livekit.rs:325-377`), no `filter` de participantes
(`:355`), passar a filtrar **duas** condições (INV-B3):

```rust
.filter(|p| p.state.as_deref() != Some("DISCONNECTED"))
.filter(|p| !p.permission.map(|perm| perm.hidden).unwrap_or(false))
.filter_map(|p| {
    let sid = p.sid?;   // sem sid não dá para endereçar; descartar
    Some(RoomParticipant {
        identity: p.identity,
        sid,
        tracks: p.tracks.into_iter()
            .map(|t| (t.sid, t.source.unwrap_or_default().to_ascii_lowercase(), t.muted))
            .collect(),
    })
})
```

Adicionar uma função para reconcile dirigido de um canal só, que evita varrer
todas as salas quando só uma precisa ser confirmada:

```rust
/// Participantes de UMA sala. Usado pelo reconcile dirigido (leave, kick,
/// move, room_finished), que não precisa varrer o servidor inteiro.
pub async fn room_participants(cfg: &Config, room: &str) -> Result<Vec<RoomParticipant>> {
    let base = http_base(cfg)?;
    let token = admin_token(cfg, serde_json::json!({ "roomAdmin": true, "room": room }))?;
    let response: ListParticipantsResponse = reqwest::Client::new()
        .post(format!("{base}/twirp/livekit.RoomService/ListParticipants"))
        .bearer_auth(token)
        .json(&serde_json::json!({ "room": room }))
        .send().await?.error_for_status()?.json().await?;
    Ok(map_participants(response.participants))
}
```

Extrair o `map_participants` para ser compartilhado por `room_snapshot` e
`room_participants`, para não haver duas cópias da regra de filtro.

Nota importante: `ListParticipants` de uma sala que não existe devolve erro ou
lista vazia dependendo da versão do LiveKit. Tratar **os dois** como
"sala vazia", nunca propagar como falha.

### 4.2 `server/src/routes/livekit.rs` — webhook v2

```rust
pub async fn webhook(State(state): State<AppState>, headers: HeaderMap, body: String) -> AppResult<()> {
    VoiceMetrics::bump(&state.voice_metrics.webhooks_received);
    let authorization = /* como em SPEC-002 */;
    let event = /* verify_webhook, como em SPEC-002 */;

    // Dedupe: uma reentrega do LiveKit não pode reaplicar nada (A10).
    let dedupe_key = match &event.id {
        Some(id) => format!("{}:{}", event.event, id),
        None => format!(
            "{}:{}:{}:{}:{}",
            event.event,
            event.room.as_ref().map(|r| r.name.as_str()).unwrap_or("-"),
            event.participant.as_ref().and_then(|p| p.sid.as_deref()).unwrap_or("-"),
            event.track.as_ref().and_then(|t| t.sid.as_deref()).unwrap_or("-"),
            event.created_at.unwrap_or(0),
        ),
    };
    if state.hub.voice.write().await.is_duplicate_event(&dedupe_key) {
        VoiceMetrics::bump(&state.voice_metrics.webhooks_ignored_duplicate);
        tracing::info!(event = "voice.webhook.ignored", outcome = "ignored_duplicate", key = %dedupe_key);
        return Ok(());
    }

    // Evento muito atrasado indica webhook em atraso: processa e força
    // reconcile daquele canal para não confiar só nele.
    let is_late = event.created_at
        .map(|at| (chrono::Utc::now().timestamp() - at) > 60)
        .unwrap_or(false);

    let Some(channel_id) = event.room.as_ref().and_then(|r| Uuid::parse_str(&r.name).ok()) else {
        tracing::info!(event = "voice.webhook.ignored", outcome = "unparsable_room");
        return Ok(());
    };

    // Espectadores nunca entram em roster (INV-B3).
    if event.participant.as_ref()
        .and_then(|p| p.permission)
        .map(|perm| perm.hidden)
        .unwrap_or(false)
    {
        VoiceMetrics::bump(&state.voice_metrics.webhooks_ignored_hidden);
        tracing::debug!(event = "voice.webhook.ignored", outcome = "hidden_participant", %channel_id);
        return Ok(());
    }

    let user_id = event.participant.as_ref().and_then(|p| Uuid::parse_str(&p.identity).ok());
    let participant_sid = event.participant.as_ref().and_then(|p| p.sid.clone());

    let change = match event.event.as_str() {
        "participant_joined" => match (user_id, participant_sid.clone()) {
            (Some(user), Some(sid)) => {
                let c = state.hub.voice.write().await.webhook_participant_joined(channel_id, user, sid);
                if !c.is_empty() { VoiceMetrics::bump(&state.voice_metrics.participants_added_by_webhook); }
                Some(c)
            }
            _ => None,
        },
        "participant_left" => match (user_id, participant_sid.clone()) {
            (Some(user), Some(sid)) => {
                let c = state.hub.voice.write().await.webhook_participant_left(channel_id, user, sid);
                if c.is_empty() {
                    VoiceMetrics::bump(&state.voice_metrics.webhooks_ignored_stale);
                    tracing::info!(event = "voice.webhook.ignored", outcome = "ignored_stale",
                                   %channel_id, %user, sid = %participant_sid.as_deref().unwrap_or("-"));
                } else {
                    VoiceMetrics::bump(&state.voice_metrics.participants_removed_by_webhook);
                }
                Some(c)
            }
            _ => None,
        },
        "track_published" => match (user_id, event.track.as_ref()) {
            (Some(user), Some(track)) => match (track.sid.clone(), TrackSource::parse(&track.source)) {
                (Some(track_sid), Some(source)) => Some(
                    state.hub.voice.write().await
                        .webhook_track_published(channel_id, user, participant_sid.clone(), track_sid, source)
                ),
                _ => None,
            },
            _ => None,
        },
        "track_unpublished" => match event.track.as_ref().and_then(|t| t.sid.clone()) {
            Some(track_sid) => Some(state.hub.voice.write().await.webhook_track_unpublished(channel_id, &track_sid)),
            None => None,
        },
        "track_muted" | "track_unmuted" => match event.track.as_ref().and_then(|t| t.sid.clone()) {
            Some(track_sid) => Some(
                state.hub.voice.write().await
                    .webhook_track_muted(channel_id, &track_sid, event.event == "track_muted")
            ),
            None => None,
        },
        // NUNCA apagar a sala aqui (RC-04). O LiveKit pode emitir isto depois
        // de alguém já ter entrado de novo. Confirmar contra a verdade.
        "room_finished" => {
            tracing::info!(event = "voice.webhook.ignored", outcome = "room_finished_defers_to_reconcile", %channel_id);
            state.schedule_reconcile(channel_id, Duration::from_millis(500)).await;
            None
        }
        "room_started" => None,
        other => {
            tracing::debug!(event = "voice.webhook.ignored", outcome = "unhandled_event", livekit_event = %other);
            None
        }
    };

    if is_late {
        tracing::warn!(event = "voice.webhook.late", %channel_id, livekit_event = %event.event);
        state.schedule_reconcile(channel_id, Duration::from_secs(1)).await;
    }

    if let Some(change) = change {
        crate::ws::handler::publish_room_change(&state, change).await;
    }
    Ok(())
}
```

`publish_room_change` é criada em SPEC-005. Nesta spec, criar uma versão
provisória que apenas chama `broadcast_voice_roster` (o comportamento v1
atual), para que a spec seja mergeável sozinha:

```rust
/// Provisório desta spec: SPEC-005 substitui pelo emissor v1+v2 completo.
pub(crate) async fn publish_room_change(state: &AppState, change: RoomChange) {
    if change.is_empty() { return; }
    broadcast_voice_roster(state, change.channel_id).await;
}
```

**Atenção crítica:** enquanto SPEC-005 não roda, `broadcast_voice_roster` lê do
`CallRegistry` antigo (`handler.rs:1223`), não do `VoiceRegistry` novo. Para
esta spec ser correta sozinha, `broadcast_voice_roster` precisa passar a ler do
`VoiceRegistry` e projetar para o formato v1. Fazer isso aqui:

```rust
pub(crate) async fn broadcast_voice_roster(state: &AppState, channel_id: Uuid) {
    let community_id = match db::channel_community(&state.pool, channel_id).await {
        Ok(Some(id)) => id,
        Ok(None) => return,
        Err(error) => { tracing::error!(%channel_id, %error, "failed to resolve voice roster community"); return; }
    };
    let (participants, streams) = {
        let voice = state.hub.voice.read().await;
        crate::ws::projection::v1_roster(&voice, channel_id)
    };
    broadcast_to_community(state, community_id,
        OutboundEnvelope::new("voice.roster", VoiceRoster { channel_id, participants, streams })).await;
}
```

E criar `server/src/ws/projection.rs` com a projeção v1 definida em
`05-protocol-spec.md` §6:

```rust
//! Projeta o VoiceRegistry v2 no formato que clientes v1 esperam.
//! Removido quando não houver mais clientes v1 (SPEC-018).

use uuid::Uuid;
use crate::ws::{protocol::{StreamDto, VoiceRosterEntry}, voice_registry::{TrackSource, VoiceRegistry}};

/// Namespace fixo para os UUID v5 de `stream_id` v1. NÃO alterar: mudar isso
/// faz todo cliente v1 tratar compartilhamentos existentes como novos.
const STREAM_NAMESPACE: Uuid = Uuid::from_u128(0x6f0c2f8c_8e40_4a3e_9d2f_1c0a1b2c3d4e);

pub fn v1_roster(voice: &VoiceRegistry, channel_id: Uuid) -> (Vec<VoiceRosterEntry>, Vec<StreamDto>) {
    let Some(room) = voice.room(channel_id) else { return (vec![], vec![]); };
    let streams = v1_streams(room, channel_id);
    let mut participants: Vec<VoiceRosterEntry> = room.participants.values().map(|p| VoiceRosterEntry {
        user_id: p.user_id,
        muted: p.muted,
        deafened: p.deafened,
        sharing: streams.iter().any(|s| s.owner == p.user_id),
        is_bot: p.is_bot,
    }).collect();
    participants.sort_by_key(|entry| entry.user_id);
    (participants, streams)
}
```

`v1_streams` agrupa tracks por `(owner, kind)`, onde `ScreenShare` e
`ScreenShareAudio` colapsam em `"screen"`, `Camera` vira `"camera"` e `Music`
vira `"music"`; gera `stream_id` com
`Uuid::new_v5(&STREAM_NAMESPACE, format!("{channel_id}:{owner}:{kind}").as_bytes())`;
define `msid` como o `track_sid` da track de vídeo do grupo; e `has_audio` como
a existência de uma `ScreenShareAudio` do mesmo dono. Ordenar por `stream_id`.

O crate `uuid` já está nas dependências com a feature `v4`
(`server/Cargo.toml`); adicionar a feature `v5`.

### 4.3 Reconcile dirigido

`server/src/state.rs`:

```rust
pub struct AppState {
    // ...
    /// Canais que precisam ser confirmados contra o LiveKit, com o instante
    /// em que devem ser processados. Consumido pelo tick de main.rs.
    pub pending_reconcile: Arc<Mutex<HashMap<Uuid, Instant>>>,
}

impl AppState {
    /// Agenda a confirmação de UM canal. Se já houver um agendamento mais
    /// cedo, mantém o mais cedo.
    pub async fn schedule_reconcile(&self, channel_id: Uuid, delay: Duration) {
        let due = Instant::now() + delay;
        let mut pending = self.pending_reconcile.lock().await;
        pending.entry(channel_id)
            .and_modify(|existing| if due < *existing { *existing = due })
            .or_insert(due);
    }

    /// Canais cujo prazo venceu, removendo-os da fila.
    pub async fn take_due_reconciles(&self) -> Vec<Uuid> {
        let now = Instant::now();
        let mut pending = self.pending_reconcile.lock().await;
        let due: Vec<Uuid> = pending.iter().filter(|(_, at)| **at <= now).map(|(id, _)| *id).collect();
        for id in &due { pending.remove(id); }
        due
    }
}
```

`server/src/main.rs`, em `spawn_voice_reconcile` (hoje `:182-197`): trocar o
`interval` de 15 s por um de **1 s**, que a cada tick faz três coisas:

```rust
let mut ticker = tokio::time::interval(Duration::from_secs(1));
let mut last_full = Instant::now();
loop {
    ticker.tick().await;

    // 1. Reconciles dirigidos que venceram (leave, kick, move, room_finished).
    for channel_id in state.take_due_reconciles().await {
        tupi_server::ws::handler::reconcile_one_room(&state, channel_id).await;
    }

    // 2. Varredura completa a cada 15 s, como hoje.
    if last_full.elapsed() >= Duration::from_secs(15) {
        last_full = Instant::now();
        tupi_server::ws::handler::reconcile_voice_rooms(&state).await;
    }

    // 3. Expira provisórios (INV-A2).
    let expired = state.hub.voice.write().await.expire_provisionals();
    for change in expired {
        VoiceMetrics::bump(&state.voice_metrics.provisional_expired);
        tracing::warn!(event = "voice.registry.participant_expired",
                       channel_id = %change.channel_id, source = "expiry");
        tupi_server::ws::handler::publish_room_change(&state, change).await;
    }
}
```

Um tick de 1 s que na maioria das vezes não faz nada custa essencialmente zero
CPU e dá granularidade ao reconcile dirigido. Manter a varredura completa em 15 s
preserva o custo de rede atual contra o LiveKit.

`server/src/ws/handler.rs` ganha:

```rust
/// Confirma UM canal contra o LiveKit. Usado quando temos motivo específico
/// para desconfiar daquele canal, em vez de varrer todos.
pub async fn reconcile_one_room(state: &AppState, channel_id: Uuid) {
    if state.config.livekit_url.is_none() { return; }
    let participants = match crate::livekit::room_participants(&state.config, &channel_id.to_string()).await {
        Ok(list) => list,
        Err(error) => {
            VoiceMetrics::bump(&state.voice_metrics.reconciles_failed);
            tracing::warn!(event = "voice.reconcile.failed", %channel_id, %error);
            return;
        }
    };
    let mapped = map_to_reconciled(participants);
    let change = state.hub.voice.write().await.reconcile_room(channel_id, mapped);
    if !change.is_empty() {
        VoiceMetrics::bump(&state.voice_metrics.reconciles_with_drift);
        tracing::warn!(event = "voice.reconcile.drift_detected", %channel_id,
                       scope = "single_room",
                       added = change.participants_added.len(),
                       removed = change.participants_removed.len());
    }
    publish_room_change(state, change).await;
}
```

E `reconcile_voice_rooms` passa a usar `VoiceRegistry::reconcile_room` por
canal mais `reconcile_prune`, publicando um `RoomChange` por canal alterado.

### 4.4 Verificação de lotação no token (INV-F2, corrige A3)

Em `server/src/routes/livekit.rs`, na função `token`, depois da verificação de
membership e antes de emitir:

```rust
if !is_bot && request.mode == Mode::Participant {
    let voice = state.hub.voice.read().await;
    if !voice.is_participant(request.channel_id, identity) && voice.is_full(request.channel_id) {
        drop(voice);
        VoiceMetrics::bump(&state.voice_metrics.tokens_refused);
        tracing::info!(event = "voice.token.refused", channel_id = %request.channel_id,
                       user_id = %identity, reason = "channel_full");
        return Err(AppError::Conflict("este canal de voz já está cheio".into()));
    }
}
```

`AppError::Conflict(String)` já existe (`server/src/error.rs:25`), já mapeia
para `StatusCode::CONFLICT` (`:61`) e já serializa `code: "conflict"` (`:46`).
Nenhuma variante nova é necessária.

O cliente v1 exibe o `message` desta resposta pelo caminho normal de erro
(`NetworkClient.cs:644-654` lê o campo `message`), então a mensagem precisa
estar em português e ser mostrável ao usuário. `05-protocol-spec.md` §7 lista
`channel_full` como código; como `AppError::Conflict` emite `code: "conflict"`,
o cliente diferencia pela mensagem, e SPEC-008 passa a tratar o `409` do
endpoint de token especificamente.

Espectadores (`Mode::Spectator`) **nunca** são barrados por lotação: eles são
`hidden` e não contam para o limite.

### 4.5 Harness de teste

`server/tests/common/mod.rs` ganha:

```rust
impl TestApp {
    /// Monta e assina um webhook exatamente como o LiveKit faz
    /// (JWT com sha256 do corpo, ver server/src/livekit.rs:224).
    pub async fn send_webhook(&self, event: serde_json::Value) -> reqwest::StatusCode {
        let body = serde_json::to_string(&event).unwrap();
        let hash = base64::engine::general_purpose::STANDARD
            .encode(sha2::Sha256::digest(body.as_bytes()));
        let claims = serde_json::json!({
            "iss": "APItestkey",
            "sha256": hash,
            "exp": (chrono::Utc::now().timestamp() + 60),
        });
        let token = sign_hs256(&claims, "test-livekit-secret");
        reqwest::Client::new()
            .post(format!("{}/api/livekit/webhook", self.http_url))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(body)
            .send().await.unwrap().status()
    }
}
```

`sign_hs256` replica o formato de `server/src/livekit.rs:264-269`. Os valores
`"APItestkey"` e `"test-livekit-secret"` vêm do config de teste
(`server/tests/common/mod.rs:69-70`).

Para `with_fake_livekit`, subir um `axum::Router` local com duas rotas
(`/twirp/livekit.RoomService/ListRooms` e `.../ListParticipants`) que devolvem
JSON controlado por um `Arc<Mutex<...>>` que o teste manipula, e apontar
`config.livekit_url` para ele. Assim `room_snapshot` e `room_participants`
funcionam sem LiveKit real.

## 5. Contratos de dados

Webhook de entrada: `05-protocol-spec.md` §5. Saída nesta spec continua sendo
`voice.roster` e `voice.rooms` v1 (projetados do registry v2).

## 6. Casos de borda a tratar

1. Webhook sem `participant.sid` (LiveKit antigo): `participant_joined` é
   descartado com log `outcome: "missing_sid"`. O reconcile cobre em até 15 s.
2. Webhook `participant_left` sem sid: mesmo tratamento.
3. `room_finished` para um canal que já não existe no registry: agenda
   reconcile mesmo assim; o `ListParticipants` volta vazio e nada muda.
4. `room.name` que não é UUID (uma sala criada fora do Tupi): ignorado.
5. `track.source` desconhecido (`"unknown"`): `TrackSource::parse` devolve
   `None`, evento descartado com log.
6. Dois webhooks concorrentes para o mesmo canal: o `RwLock` do `Hub` serializa;
   o segundo vê o resultado do primeiro. A ordem entre eles é a de chegada,
   e a proteção contra ordem errada é o sid, não o lock.
7. `ListParticipants` de sala inexistente: tratado como lista vazia
   (§4.1), nunca como erro.
8. `created_at` ausente: `is_late` é `false`; o dedupe usa a chave composta.
9. Relógio do servidor atrasado em relação ao do LiveKit: `is_late` pode dar
   falso positivo e agendar um reconcile a mais. Custo aceito; um reconcile
   extra é inofensivo.
10. Fila `pending_reconcile` com muitos canais: limitada naturalmente ao número
    de canais de voz da comunidade (19 no seed, `server/src/main.rs:270-281`).
11. `schedule_reconcile` chamado com o LiveKit não configurado:
    `reconcile_one_room` faz `return` no primeiro `if`.

## 7. Critérios de aceite

- **Dado** um webhook `participant_joined` para o usuário A com sid S1,
  **quando** chega um `participant_left` para A com sid S0, **então** A
  permanece no roster e existe um log com `outcome: "ignored_stale"`.
- **Dado** um webhook `room_finished` para um canal com dois participantes
  ainda listados pelo LiveKit, **então** o roster permanece com os dois após o
  reconcile dirigido.
- **Dado** um participante com `permission.hidden: true`, **então** ele nunca
  aparece em `voice.roster` nem no `GET /api/debug/voice`.
- **Dado** o mesmo webhook entregue duas vezes, **então** a `version` do canal
  sobe exatamente uma vez.
- **Dado** que o canal tem 10 participantes humanos confirmados, **quando** um
  11º pede token de `participant`, **então** recebe `409` com
  `code: "channel_full"`.
- **Dado** que o canal tem 10 humanos, **quando** alguém pede token de
  `spectator`, **então** recebe `200`.
- **Dado** uma tela publicada (TR_1), despublicada e republicada (TR_2),
  **então** o `voice.roster` projetado tem exatamente um stream de tela e seu
  `msid` é `TR_2`.
- **Dado** o mesmo compartilhamento em dois broadcasts consecutivos, **então**
  o `stream_id` projetado é idêntico nos dois.
- **Dado** um `leave` seguido de reconcile dirigido em 2 s, **então** o
  participante é removido em no máximo 2 s.

## 8. Como testar

### Automatizado

Testes I-01, I-04 a I-11, I-15, I-18 de `07-test-plan.md` §3, mais os
unitários U-01 a U-18 que SPEC-003 já criou (agora exercitados pelo caminho
real).

### Manual

Roteiros M-01 (fantasma de canal) e M-07 (restart do app) de
`07-test-plan.md` §5, com clientes **v1 ainda** (a build atual de produção).
Este é o ponto: a correção precisa ser visível sem atualizar cliente nenhum.

Passo extra de verificação:

1. Com dois clientes em um canal, parar o container do `tupi-server`
   (`docker compose stop tupi-server`), esperar 20 s, subir de novo.
2. Em até 20 s após subir, `GET /api/debug/voice` mostra os dois participantes
   com sids reais, e as sidebars voltam a mostrá-los.

## 9. Riscos e rollback

| Risco | Mitigação |
|---|---|
| A projeção v1 muda o `stream_id` e clientes v1 remontam tiles | UUID v5 determinístico; teste I-15 |
| `room_finished` deixando de apagar deixa salas fantasma se o reconcile falhar | A varredura completa de 15 s remove salas que o LiveKit não lista (`reconcile_prune`) |
| Tick de 1 s aumenta consumo | Um tick vazio é uma comparação de `Instant`; medido em nanossegundos |
| `ListParticipants` por canal aumenta chamadas ao LiveKit | Reconcile dirigido só roda por evento específico, não continuamente |
| Feature `v5` do uuid aumenta o binário | Alguns kilobytes |

**Rollback:** `git revert`. Como a spec troca a fonte de `broadcast_voice_roster`,
reverter volta ao `CallRegistry`, que continua íntegro (ninguém o removeu).

## 10. Fora de escopo

- Não emitir ops v2 (`voice.room.state` / `.delta`): SPEC-005.
- Não mudar as ops de entrada `voice.presence.*` nem `voice.track.*`: SPEC-005.
- Não remover o `CallRegistry`: SPEC-018.
- Não mexer no cliente.
- Não mudar `HEARTBEAT_TIMEOUT` nem o grace de presença.
