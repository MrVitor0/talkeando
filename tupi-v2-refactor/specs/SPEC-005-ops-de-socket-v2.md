# SPEC-005 — Ops de socket v2 e desconexão que não mexe em voz

## 1. Problema

**Causas raiz:** RC-01 (cliente escreve presença como autoridade), RC-05 (a
queda do WS evicta da voz), RC-11 (parte: broadcasts redundantes), A1
(`voice.track.unpublished` sem validação nenhuma), A2 (`voice.presence.leave`
sem validação de membership), A5 (query ao Postgres por evento de roster).

O trecho mais danoso é `server/src/ws/handler.rs:234-236`: 8 s depois de o
WebSocket cair, o servidor remove a pessoa de todos os canais de voz, embora o
WebSocket não seja o transporte de mídia. Um deploy do servidor derruba os
sockets de todo mundo e produz o "sumiu todo mundo" coletivo.

**Sintomas que desaparecem:** 1 (fantasmas), 2 (estado perdido no restart),
parte do 3.

## 2. Prioridade e dependências

- **Prioridade:** P0
- **Dependências:** SPEC-001 (versão negociada), SPEC-003 (`VoiceRegistry`),
  SPEC-004 (webhook e reconcile já escrevem o registry v2).

## 3. Arquivos afetados

| Arquivo | Ação |
|---|---|
| `server/src/ws/handler.rs` | editar: dispatch de ops v2, remoção do evict por desconexão, `publish_room_change` real |
| `server/src/ws/projection.rs` | editar: adicionar projeção de delta v1 |
| `server/src/ws/mod.rs` | editar: `server_features` passa a anunciar as capacidades |
| `server/src/ws/hub.rs` | editar: cache de membros da comunidade |
| `server/src/state.rs` | editar: cache de comunidade por canal |
| `server/src/routes/channels.rs` | editar: exclusão de canal usa o registry v2 |
| `server/tests/voice_test.rs` | editar: I-02, I-03, I-12 a I-14, I-16, I-17, I-19, I-20 |

## 4. Mudança especificada

### 4.1 A desconexão do WebSocket para de mexer na voz (INV-A3)

Em `handle_socket` (`handler.rs:207-252`), **remover** este bloco:

```rust
// REMOVER (handler.rs:214)
let left_calls: Vec<Uuid> = joined_calls.into_iter().collect();

// REMOVER (handler.rs:234-236)
for channel_id in left_calls {
    evict_voice_participant(&delayed_state, channel_id, user_id).await;
}
```

Substituir por: quando o último socket do usuário cai, agendar um reconcile de
cada canal em que ele estava, com 5 s de atraso. Se a pessoa realmente saiu do
LiveKit, o reconcile confirma e remove. Se ela continua na sala (o caso comum
de um blip de rede ou deploy), nada acontece — que é exatamente o
comportamento correto.

```rust
// Dentro do tokio::spawn do grace period, no lugar do evict:
for channel_id in joined_calls.iter().copied() {
    delayed_state.schedule_reconcile(channel_id, Duration::from_secs(5)).await;
}
```

`joined_calls` deixa de ser consumido por `into_iter()` e passa a ser lido;
ajustar o tipo de captura no `spawn` (clonar o `HashSet` antes de mover).

O restante do bloco de desconexão (presença offline, atividade, sessões de
jogo) fica **inalterado**. Presença online/offline continua ligada ao socket,
como deve ser.

### 4.2 Ops de entrada v2

No `match env.op.as_str()` de `dispatch` (`handler.rs:492`), adicionar:

```rust
"voice.presence.hint" => {
    let data: VoicePresenceHint = parse_or_reject!(VoicePresenceHint);
    handle_presence_hint(state, user_id, connection_id, data, joined_calls).await;
}
"voice.track.hint" => {
    let data: VoiceTrackHint = parse_or_reject!(VoiceTrackHint);
    handle_track_hint(state, user_id, data, joined_calls).await;
}
"voice.room.request" => {
    let data: VoiceRoomRequest = parse_or_reject!(VoiceRoomRequest);
    handle_room_request(state, user_id, connection_id, data).await;
}
```

E **traduzir** as ops v1 para os mesmos handlers, em vez de duplicar lógica:

```rust
"voice.presence.enter" => {
    let data: VoicePresence = parse_or_reject!(VoicePresence);
    handle_presence_hint(state, user_id, connection_id,
        VoicePresenceHint { channel_id: data.channel_id, state: "joining".into(), participant_sid: None },
        joined_calls).await;
}
"voice.presence.leave" => {
    let data: VoicePresence = parse_or_reject!(VoicePresence);
    handle_presence_hint(state, user_id, connection_id,
        VoicePresenceHint { channel_id: data.channel_id, state: "leaving".into(), participant_sid: None },
        joined_calls).await;
}
"voice.track.published" | "voice.track.unpublished" => {
    let data: VoiceTrack = parse_or_reject!(VoiceTrack);
    let Some(track_sid) = data.track_sid else {
        tracing::info!(event = "voice.registry.track_hint_ignored", %user_id,
                       channel_id = %data.channel_id, outcome = "missing_track_sid");
        return;
    };
    handle_track_hint(state, user_id,
        VoiceTrackHint {
            channel_id: data.channel_id,
            track_sid,
            source: data.source,
            state: if env.op == "voice.track.published" { "published".into() } else { "unpublished".into() },
        },
        joined_calls).await;
}
"voice.rooms.request" => {
    handle_room_request(state, user_id, connection_id, VoiceRoomRequest { channel_ids: vec![] }).await;
}
```

Uma única implementação serve os dois dialetos. É o que impede a projeção v1 de
divergir da v2 (o risco número um de `08-rollout-plan.md` §8).

### 4.3 `handle_presence_hint`

```rust
async fn handle_presence_hint(
    state: &AppState,
    user_id: Uuid,
    connection_id: Uuid,
    data: VoicePresenceHint,
    joined_calls: &mut HashSet<Uuid>,
) {
    // Validação de membership vale para os dois estados (corrige A2).
    let allowed = if user_id == MUSIC_BOT_ID {
        matches!(db::channel_by_id(&state.pool, data.channel_id).await, Ok(Some(c)) if c.kind == "voice")
    } else {
        matches!(db::channel_if_member(&state.pool, data.channel_id, user_id).await, Ok(Some(c)) if c.kind == "voice")
    };
    if !allowed {
        state.hub.send_to_connection(user_id, connection_id,
            OutboundEnvelope::error("forbidden", "not allowed to join this voice channel", None)).await;
        return;
    }

    match data.state.as_str() {
        "joining" => {
            // Trocar de canal: a saída do anterior é uma dica, não uma ordem.
            for previous in joined_calls.clone() {
                if previous == data.channel_id { continue; }
                joined_calls.remove(&previous);
                let (change, needs_reconcile) = state.hub.voice.write().await.hint_leaving(previous, user_id);
                if needs_reconcile { state.schedule_reconcile(previous, Duration::from_secs(2)).await; }
                publish_room_change(state, change).await;
            }
            joined_calls.insert(data.channel_id);
            let change = state.hub.voice.write().await.hint_joining(
                data.channel_id, user_id, data.participant_sid.clone(), user_id == MUSIC_BOT_ID);
            tracing::info!(event = "voice.registry.participant_added", channel_id = %data.channel_id,
                           %user_id, source = "ws",
                           participant_sid = data.participant_sid.as_deref().unwrap_or("-"),
                           outcome = if change.is_empty() { "noop" } else { "applied" });
            publish_room_change(state, change).await;
        }
        "leaving" => {
            joined_calls.remove(&data.channel_id);
            let (change, needs_reconcile) = state.hub.voice.write().await.hint_leaving(data.channel_id, user_id);
            if needs_reconcile {
                // INV-A1: um participante confirmado não sai por dica.
                // Confirmamos contra o LiveKit em 2 s.
                state.schedule_reconcile(data.channel_id, Duration::from_secs(2)).await;
                tracing::info!(event = "voice.registry.leave_hint_deferred",
                               channel_id = %data.channel_id, %user_id, source = "ws");
            }
            publish_room_change(state, change).await;
        }
        other => {
            tracing::info!(event = "voice.registry.hint_ignored", %user_id, state = %other);
        }
    }
}
```

Aceleração opcional e importante: quando `data.participant_sid` vem preenchido
em um `leaving`, o servidor **pode** chamar `RemoveParticipant` no LiveKit para
tornar a saída imediata em vez de esperar 2 s. Fazer isso apenas quando o sid
informado bate com o sid registrado para aquele usuário, para que um cliente não
possa desconectar outra sessão. Implementar:

```rust
if data.state == "leaving" {
    let matches_sid = {
        let voice = state.hub.voice.read().await;
        voice.room(data.channel_id)
            .and_then(|room| room.participants.get(&user_id))
            .and_then(|p| p.sid.clone())
            .zip(data.participant_sid.clone())
            .map(|(registered, informed)| registered == informed)
            .unwrap_or(false)
    };
    if matches_sid {
        let cfg = state.config.clone();
        let channel = data.channel_id.to_string();
        let identity = user_id.to_string();
        tokio::spawn(async move {
            if let Err(error) = crate::livekit::remove_participant(&cfg, &channel, &identity).await {
                tracing::warn!(event = "voice.leave.remove_failed", %error);
            }
        });
    }
}
```

Isso dá ao cliente v2 uma saída praticamente instantânea, mantendo o LiveKit
como autoridade: quem remove é o LiveKit, e o webhook confirma.

### 4.4 `handle_track_hint`

```rust
async fn handle_track_hint(
    state: &AppState,
    user_id: Uuid,
    data: VoiceTrackHint,
    joined_calls: &HashSet<Uuid>,
) {
    let Some(source) = TrackSource::parse(&data.source) else {
        tracing::info!(event = "voice.registry.track_hint_ignored", %user_id, source = %data.source,
                       outcome = "unknown_source");
        return;
    };
    let published = match data.state.as_str() {
        "published" => true,
        "unpublished" => false,
        _ => return,
    };
    // Exigência mínima: a dica só vale para um canal que esta conexão anunciou.
    if !joined_calls.contains(&data.channel_id) {
        tracing::info!(event = "voice.registry.track_hint_ignored", %user_id,
                       channel_id = %data.channel_id, outcome = "not_in_channel");
        return;
    }
    let result = state.hub.voice.write().await
        .hint_track(data.channel_id, user_id, data.track_sid.clone(), source, published);
    match result {
        Ok(change) => publish_room_change(state, change).await,
        Err(HintError::NotTrackOwner) => {
            // INV-F1: corrige A1 (hoje qualquer um apaga a track de qualquer um).
            tracing::warn!(event = "voice.registry.track_hint_rejected", %user_id,
                           channel_id = %data.channel_id, track_sid = %data.track_sid,
                           outcome = "not_owner");
            state.hub.send_to(user_id,
                OutboundEnvelope::error("forbidden", "you do not own this track", None)).await;
        }
        Err(_) => { /* track desconhecida ou fora de call: silencioso */ }
    }
}
```

A verificação de `joined_calls` passa a valer também para `unpublished`, que
hoje não tem nenhuma (`handler.rs:615`).

### 4.5 `publish_room_change` — o emissor dos dois dialetos

Substitui a versão provisória de SPEC-004:

```rust
/// Emite a mudança para a comunidade: delta v2 para conexões v2, roster v1
/// completo para conexões v1. Uma única fonte, duas projeções.
pub(crate) async fn publish_room_change(state: &AppState, change: RoomChange) {
    if change.is_empty() { return; }
    let Some(community_id) = state.community_of_channel(change.channel_id).await else { return; };
    let Ok(recipients) = state.community_members(community_id).await else { return; };

    // v2: delta versionado.
    let delta = VoiceRoomDelta {
        channel_id: change.channel_id,
        version: change.version_after,
        previous_version: change.version_before,
        participants_added: change.participants_added.iter().map(Into::into).collect(),
        participants_updated: change.participants_updated.iter().map(Into::into).collect(),
        participants_removed: change.participants_removed.clone(),
        tracks_added: change.tracks_added.iter().map(Into::into).collect(),
        tracks_removed: change.tracks_removed.clone(),
        reason: serde_json::to_value(change.reason).ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default(),
    };
    VoiceMetrics::bump(&state.voice_metrics.deltas_sent);
    state.hub.broadcast_to_versioned(&recipients, 2,
        OutboundEnvelope::new("voice.room.delta", delta)).await;

    // v1: roster completo do canal, projetado do mesmo estado.
    let (participants, streams) = {
        let voice = state.hub.voice.read().await;
        crate::ws::projection::v1_roster(&voice, change.channel_id)
    };
    state.hub.broadcast_to_max_version(&recipients, 1,
        OutboundEnvelope::new("voice.roster",
            VoiceRoster { channel_id: change.channel_id, participants, streams })).await;
}
```

`broadcast_voice_roster` deixa de existir como função pública; todas as
chamadas passam por `publish_room_change`. Isso garante que nenhum caminho
emita v1 sem emitir v2 e vice-versa. Os pontos que hoje chamam
`broadcast_voice_roster` diretamente (`routes/livekit.rs`, `routes/channels.rs:288`)
passam a usar o `RoomChange` devolvido pela mutação correspondente.

### 4.6 Cache de destinatários (corrige A5)

Hoje cada broadcast de roster faz duas queries (`channel_community` e
`community_member_ids`). Com o tick de 1 s e vários eventos por join, isso é
carga desnecessária no Postgres remoto (Neon).

`server/src/state.rs`:

```rust
/// Cache de `channel_id -> community_id` e de membros por comunidade.
/// Canais e membros mudam raramente; um TTL curto é suficiente e elimina
/// duas queries por evento de roster.
pub struct AppState {
    // ...
    pub channel_community_cache: Arc<Mutex<HashMap<Uuid, (Uuid, Instant)>>>,
    pub community_members_cache: Arc<Mutex<HashMap<Uuid, (Vec<Uuid>, Instant)>>>,
}

const CHANNEL_COMMUNITY_TTL: Duration = Duration::from_secs(300);
const COMMUNITY_MEMBERS_TTL: Duration = Duration::from_secs(60);

impl AppState {
    pub async fn community_of_channel(&self, channel_id: Uuid) -> Option<Uuid> { /* ... */ }
    pub async fn community_members(&self, community_id: Uuid) -> Result<Vec<Uuid>, sqlx::Error> { /* ... */ }
    /// Invalidação explícita, chamada ao criar/apagar canal e ao entrar membro.
    pub async fn invalidate_channel_cache(&self, channel_id: Uuid) { /* ... */ }
    pub async fn invalidate_members_cache(&self, community_id: Uuid) { /* ... */ }
}
```

Chamar `invalidate_channel_cache` em `routes/channels.rs` nos handlers de
criação, atualização e exclusão de canal; `invalidate_members_cache` em
`routes/invites.rs` no aceite de convite e em `routes/auth.rs` no registro.
Localizar esses pontos pelos `INSERT INTO community_members` e
`DELETE FROM channels` existentes.

O TTL curto é a rede de segurança para qualquer ponto de invalidação esquecido:
o pior caso é um membro novo não receber broadcasts de roster por até 60 s.

### 4.7 `voice.room.request` e o snapshot v2

```rust
async fn handle_room_request(
    state: &AppState,
    user_id: Uuid,
    connection_id: Uuid,
    data: VoiceRoomRequest,
) {
    if !state.allow_room_request(user_id).await {
        VoiceMetrics::bump(&state.voice_metrics.version_gaps_reported);
        state.hub.send_to_connection(user_id, connection_id,
            OutboundEnvelope::error("rate_limited", "muitas solicitações de estado", None)).await;
        return;
    }
    send_voice_room_state(state, user_id, connection_id, &data.channel_ids).await;
}
```

`allow_room_request`: janela deslizante de 10 s com máximo de 5 por usuário,
no mesmo padrão de `check_login_rate_limit` (`state.rs:493`).

`send_voice_room_state` substitui `send_voice_rooms_snapshot`
(`handler.rs:1333`) e emite conforme a versão da conexão:

```rust
async fn send_voice_room_state(
    state: &AppState,
    user_id: Uuid,
    connection_id: Uuid,
    only: &[Uuid],
) {
    // Um snapshot pedido é sinal de que o cliente desconfia do próprio
    // estado. Confirmar contra o LiveKit primeiro, com o throttle existente.
    if state.should_reconcile_voice(Duration::from_secs(5)).await {
        reconcile_voice_rooms(state).await;
    }
    let active = state.hub.voice.read().await.active_channel_ids();
    let wanted: Vec<Uuid> = if only.is_empty() {
        active
    } else {
        active.into_iter().filter(|id| only.contains(id)).collect()
    };
    let visible = match db::visible_channel_ids(&state.pool, user_id, &wanted).await {
        Ok(list) => list,
        Err(error) => { tracing::error!(%user_id, %error, "failed to build voice room state"); return; }
    };

    let protocol = state.hub.connection_protocol(user_id, connection_id).await.unwrap_or(1);
    VoiceMetrics::bump(&state.voice_metrics.snapshots_sent);
    if protocol >= 2 {
        let voice = state.hub.voice.read().await;
        let rooms: Vec<VoiceRoomDto> = visible.iter()
            .filter_map(|id| crate::ws::projection::v2_room(&voice, *id))
            .collect();
        drop(voice);
        state.hub.send_to_connection(user_id, connection_id,
            OutboundEnvelope::new("voice.room.state", VoiceRoomState { full: true, rooms })).await;
    } else {
        let voice = state.hub.voice.read().await;
        let rooms: Vec<VoiceRoster> = visible.iter().map(|id| {
            let (participants, streams) = crate::ws::projection::v1_roster(&voice, *id);
            VoiceRoster { channel_id: *id, participants, streams }
        }).filter(|r| !r.participants.is_empty()).collect();
        drop(voice);
        state.hub.send_to_connection(user_id, connection_id,
            OutboundEnvelope::new("voice.rooms", VoiceRoomsSnapshot { rooms })).await;
    }
}
```

`Hub::connection_protocol(user_id, connection_id) -> Option<u8>` é um getter
novo, trivial, sobre o `ConnMeta` de SPEC-001.

O `send_voice_rooms_snapshot` chamado no handshake (`handler.rs:151`) passa a
chamar `send_voice_room_state(state, user_id, connection_id, &[])`.

### 4.8 `server_features`

```rust
pub fn server_features(config: &crate::config::Config) -> Vec<String> {
    let mut features = Vec::new();
    if config.voice_protocol_v2 {
        features.push("voice.room.v2".to_string());
        features.push("voice.hints".to_string());
    }
    features
}
```

`server/src/config.rs` ganha:

```rust
/// Escotilha de emergência do rollout (08-rollout-plan.md §4).
pub voice_protocol_v2: bool,
// em from_env():
voice_protocol_v2: env::var("TUPI_VOICE_PROTOCOL_V2")
    .map(|value| value != "0" && value.to_ascii_lowercase() != "false")
    .unwrap_or(true),
```

Quando `voice_protocol_v2` é `false`, `MAX_SERVER_PROTOCOL` efetivo vira 1 na
negociação de SPEC-001. Implementar comparando com um valor calculado em vez da
constante:

```rust
let server_max = if state.config.voice_protocol_v2 { MAX_SERVER_PROTOCOL } else { 1 };
let negotiated = hello.protocol_version.min(server_max);
```

### 4.9 Exclusão de canal

`server/src/routes/channels.rs:288` hoje chama `clear_channel` do registry
antigo. Trocar por:

```rust
let change = state.hub.voice.write().await.close_channel(channel_id);
crate::ws::handler::publish_room_change(&state, change).await;
state.invalidate_channel_cache(channel_id).await;
```

`close_channel` precisa devolver um `RoomChange` com `reason: ChannelDeleted`
e `room_closed: true`, e o `publish_room_change` precisa emitir esse caso
mesmo com a sala já removida do mapa (o delta carrega os removidos).

## 5. Contratos de dados

`05-protocol-spec.md` §2, §3 e §6. As conversões `From<&VoiceParticipant> for
VoiceParticipantDto` e `From<&VoiceTrack> for VoiceTrackDto` ficam em
`voice_registry.rs`, ao lado dos tipos.

## 6. Casos de borda a tratar

1. `hint_leaving` de um canal em que o usuário nunca esteve: `RoomChange`
   vazio, `needs_reconcile: false`, nada é emitido.
2. Duas conexões do mesmo usuário, uma manda `joining` no canal A e a outra no
   canal B: `joined_calls` é por conexão, então ambas anunciam. O registry tem
   o usuário em dois canais até o reconcile resolver, e o LiveKit só o tem em
   um. O reconcile remove o errado em até 15 s. Documentar como comportamento
   conhecido e aceito: abrir dois apps e entrar em canais diferentes é um caso
   de uso inválido que se auto-corrige.
3. `voice.room.request` com `channel_ids` contendo canal de outra comunidade:
   `visible_channel_ids` já filtra (`db.rs:172`).
4. `voice.room.request` com 500 ids: `visible_channel_ids` usa `ANY($2)`;
   limitar a 100 ids antes da query para evitar payload grande.
5. Conexão v1 recebendo `publish_room_change` de um canal que ficou vazio: o
   `v1_roster` devolve listas vazias e o cliente v1 apaga a chave
   (`App.tsx:1375`), que é o comportamento correto de hoje.
6. `publish_room_change` com `room_closed: true`: emitir o delta v2 com os
   removidos **e** o roster v1 vazio.
7. Bot de música: conecta com `protocol_version` 1 até SPEC-015; recebe as ops
   v1 e continua funcionando.
8. Cache de membros vencido durante um broadcast: pior caso é uma query a mais.
9. `remove_participant` disparado em `tokio::spawn` falhando: só loga; o
   reconcile de 2 s é o caminho garantido.

## 7. Critérios de aceite

- **Dado** um usuário confirmado em um canal, **quando** o WebSocket dele cai e
  ele permanece no LiveKit, **então** após 30 s ele **continua** no roster de
  todos. **INV-A3, o teste central desta spec.**
- **Dado** um usuário confirmado, **quando** ele envia `voice.presence.leave`
  (v1) ou `hint leaving` sem sid, **então** ele permanece até o reconcile
  dirigido de 2 s confirmar a saída real.
- **Dado** um cliente v2 que envia `leaving` com o `participant_sid` correto,
  **então** o servidor chama `RemoveParticipant` e a saída é confirmada pelo
  webhook em menos de 1 s.
- **Dado** um cliente v2, **quando** qualquer mudança de sala ocorre, **então**
  ele recebe `voice.room.delta` e **não** recebe `voice.roster`.
- **Dado** um cliente v1, **então** ele recebe `voice.roster` e **não** recebe
  `voice.room.delta`.
- **Dado** o usuário A tentando `voice.track.hint unpublished` de uma track de
  B, **então** recebe `forbidden` e o registry não muda.
- **Dado** um `voice.presence.hint` para um canal de outra comunidade, **então**
  recebe `forbidden`.
- **Dado** 6 `voice.room.request` em 10 s, **então** o 6º recebe
  `rate_limited`.
- **Dado** `TUPI_VOICE_PROTOCOL_V2=false`, **então** nenhuma conexão negocia 2 e
  `features` volta vazio.
- **Dado** 10 eventos de roster no mesmo canal em 1 s, **então** o Postgres
  recebe no máximo 2 queries (uma por cache frio).

## 8. Como testar

### Automatizado

Testes I-02, I-03, I-12, I-13, I-14, I-16, I-17, I-19, I-20 de
`07-test-plan.md` §3.

O I-02 é o mais importante e precisa ser escrito com cuidado: usar
`WsClient::terminate` (fechamento abrupto sem frame de close, já disponível no
padrão do `integration/sfu/run.cjs`; adicionar ao `WsClient` de
`server/tests/common/mod.rs` se não existir), com o fake LiveKit continuando a
listar o participante. A asserção é que, após 30 s simulados, um segundo
cliente ainda o vê.

Para não gastar 30 s reais no teste, injetar o intervalo de grace por
configuração: adicionar `ws_offline_grace_seconds` ao `Config` (default 8) e
usar 1 nos testes.

### Manual

- M-01 (fantasma de canal), agora com clientes v1 **e** com um v2 simulado pelo
  harness.
- Verificação específica de INV-A3: com dois clientes em call, matar o processo
  do servidor e subir de novo. As duas pessoas devem continuar se ouvindo o
  tempo todo, e voltar ao roster em até 20 s sem clicar em nada.

## 9. Riscos e rollback

| Risco | Mitigação |
|---|---|
| Sair de um canal passa a demorar 2 s no cliente v1 | Aceito e documentado (`08-rollout-plan.md` §3.1); flag `TUPI_VOICE_LEAVE_HINT_AUTHORITATIVE` como escotilha |
| Delta v2 e roster v1 divergindo | Ambos derivados do mesmo `VoiceRegistry` na mesma função; testes I-13 e I-14 |
| Cache de membros servindo lista velha | TTL de 60 s mais invalidação explícita |
| Remover o evict deixa fantasmas se o LiveKit também perder o participante | O reconcile agendado em 5 s e a varredura de 15 s cobrem |
| `RemoveParticipant` sendo usado maliciosamente | Só dispara quando o sid informado bate com o registrado |

**Rollback:** `git revert`, ou `TUPI_VOICE_PROTOCOL_V2=false` para desligar só
o dialeto v2 mantendo as correções de autoridade (que são o valor principal).

## 10. Fora de escopo

- Não mexer no cliente (SPEC-007 e SPEC-008).
- Não remover `CallRegistry` (SPEC-018).
- Não mudar presença online/offline nem o grace de 8 s.
- Não mudar `call.state.update` além de passar a emitir também o delta v2.
- Não tocar em chat, atividade ou anexos.
