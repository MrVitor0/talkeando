# SPEC-003 — `VoiceRegistry` v2: estado endereçado por SID e versionado

## 1. Problema

**Causas raiz:** RC-01 (duas autoridades sem precedência), RC-02 (parcialmente,
o lado servidor), RC-03 (streams com UUID inventado em vez do SID do LiveKit),
RC-05 (o lado do estado), A9 (reconcile recria ids e perde `viewers`).

O `CallRegistry` atual (`server/src/ws/call_registry.rs`) indexa tracks por
`Uuid::new_v4()` (`:120`, `:128`, `:552`) e participantes só por `user_id`, sem
o sid da sessão. Isso torna impossível distinguir um evento obsoleto de um
atual, e faz uma tela republicada colidir com a linha da tela anterior.

Não há versão por sala, então a perda de uma mensagem para o cliente é
indetectável.

**Sintomas que começam a desaparecer:** 1 (fantasmas), 4 (segunda tela não
aparece). Esta spec entrega a estrutura; SPEC-004 e SPEC-005 ligam as entradas.

## 2. Prioridade e dependências

- **Prioridade:** P0
- **Dependências:** SPEC-002 (usa `VoiceMetrics`).

## 3. Arquivos afetados

| Arquivo | Ação |
|---|---|
| `server/src/ws/voice_registry.rs` | criar |
| `server/src/ws/call_registry.rs` | manter como está nesta spec; será removido em SPEC-018 |
| `server/src/ws/hub.rs` | editar: adicionar `voice: RwLock<VoiceRegistry>` ao lado de `calls` |
| `server/src/ws/mod.rs` | editar: declarar o módulo |
| `server/src/ws/protocol.rs` | editar: DTOs v2 |

Estratégia deliberada: o `VoiceRegistry` novo nasce **ao lado** do
`CallRegistry`, sem substituí-lo. SPEC-004 e SPEC-005 migram os escritores e
leitores um a um; SPEC-018 remove o antigo. Isso mantém cada PR pequeno e o
produto funcionando entre eles.

## 4. Mudança especificada

### 4.1 Tipos

`server/src/ws/voice_registry.rs`:

```rust
//! Projeção convergente do estado de sala do LiveKit.
//!
//! Autoridade: o LiveKit (ver tupi-v2-refactor/03-target-architecture.md §1).
//! Este registro é um cache que converge para ele. Mutações de presença
//! confirmada só entram por `apply_webhook` e `apply_reconcile` (INV-A1).

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use uuid::Uuid;

pub type ChannelId = Uuid;
pub type UserId = Uuid;
/// SID de sessão de participante do LiveKit (ex.: "PA_xxxxx").
pub type ParticipantSid = String;
/// SID de publicação de track do LiveKit (ex.: "TR_xxxxx").
pub type TrackSid = String;

pub const MUSIC_BOT_ID: Uuid = Uuid::from_u128(1);
/// Tempo máximo que um participante anunciado só pelo cliente sobrevive sem
/// confirmação do LiveKit (INV-A2).
pub const PROVISIONAL_TTL: Duration = Duration::from_secs(10);
/// Máximo de participantes humanos por canal (INV-F2).
pub const MAX_HUMAN_PARTICIPANTS: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TrackSource {
    Microphone,
    Camera,
    ScreenShare,
    ScreenShareAudio,
    /// Linha sintética do bot de música; não corresponde a uma track do
    /// LiveKit e é a única exceção documentada a INV-B1.
    Music,
}

impl TrackSource {
    /// Converte o `source` do webhook / ListParticipants do LiveKit.
    /// Retorna `None` para fontes que não projetamos (ex.: "unknown").
    pub fn parse(value: &str) -> Option<Self> {
        match value.to_ascii_lowercase().as_str() {
            "microphone" => Some(Self::Microphone),
            "camera" => Some(Self::Camera),
            "screen_share" => Some(Self::ScreenShare),
            "screen_share_audio" => Some(Self::ScreenShareAudio),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct VoiceParticipant {
    pub user_id: UserId,
    /// `None` enquanto provisório (anunciado pelo cliente, não confirmado).
    pub sid: Option<ParticipantSid>,
    pub joined_at: DateTime<Utc>,
    /// Instante em que virou provisório; usado para expirar (INV-A2).
    pub provisional_since: Option<Instant>,
    pub muted: bool,
    pub deafened: bool,
    pub is_bot: bool,
}

impl VoiceParticipant {
    pub fn is_provisional(&self) -> bool { self.sid.is_none() }
}

#[derive(Debug, Clone)]
pub struct VoiceTrack {
    pub sid: TrackSid,
    pub owner: UserId,
    pub owner_sid: Option<ParticipantSid>,
    pub source: TrackSource,
    pub muted: bool,
}

#[derive(Debug)]
pub struct VoiceRoom {
    /// Monotônico por canal; só incrementa em mutação aceita (INV-C2).
    pub version: u64,
    pub participants: HashMap<UserId, VoiceParticipant>,
    /// Chave é o SID do LiveKit, nunca um id inventado (INV-B1).
    pub tracks: HashMap<TrackSid, VoiceTrack>,
    pub reconciled_at: Option<Instant>,
}

impl Default for VoiceRoom {
    fn default() -> Self {
        Self { version: 0, participants: HashMap::new(), tracks: HashMap::new(), reconciled_at: None }
    }
}

#[derive(Debug, Default)]
pub struct VoiceRegistry {
    rooms: HashMap<ChannelId, VoiceRoom>,
    /// Últimos eventos de webhook processados, para dedupe. Ordem de inserção
    /// mantida por `order`; capacidade fixa de 512.
    seen_events: HashSet<String>,
    seen_order: std::collections::VecDeque<String>,
}
```

### 4.2 O tipo de mudança devolvido

Toda mutação devolve o que mudou, para o chamador emitir o delta correto sem
recalcular nada:

```rust
/// O que uma mutação alterou. `version_after == version_before` significa
/// que nada mudou e nenhum delta deve ser emitido.
#[derive(Debug, Default, Clone)]
pub struct RoomChange {
    pub channel_id: ChannelId,
    pub version_before: u64,
    pub version_after: u64,
    pub participants_added: Vec<VoiceParticipant>,
    pub participants_updated: Vec<VoiceParticipant>,
    pub participants_removed: Vec<UserId>,
    pub tracks_added: Vec<VoiceTrack>,
    pub tracks_removed: Vec<TrackSid>,
    pub reason: ChangeReason,
    /// True quando o canal deixou de existir (ficou sem participantes).
    pub room_closed: bool,
}

impl RoomChange {
    pub fn is_empty(&self) -> bool { self.version_after == self.version_before }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeReason {
    WebhookParticipantJoined,
    WebhookParticipantLeft,
    WebhookTrackPublished,
    WebhookTrackUnpublished,
    WebhookTrackMuted,
    ReconcileAdded,
    ReconcileRemoved,
    ReconcileTrackSync,
    WsPresenceHint,
    WsStateUpdate,
    WsTrackHint,
    AdminDisconnectMember,
    ChannelDeleted,
    ProvisionalExpired,
}
```

`ChangeReason` serializa exatamente para os valores da tabela de
`05-protocol-spec.md` §2.2. Um `#[test]` confere isso (§8).

### 4.3 Operações

```rust
impl VoiceRegistry {
    // ---------- leitura ----------

    pub fn room(&self, channel_id: ChannelId) -> Option<&VoiceRoom>;
    pub fn active_channel_ids(&self) -> Vec<ChannelId>;
    pub fn version(&self, channel_id: ChannelId) -> u64;
    pub fn is_participant(&self, channel_id: ChannelId, user_id: UserId) -> bool;
    pub fn participant_ids(&self, channel_id: ChannelId) -> Vec<UserId>;
    /// Canal em que `user_id` está, se algum. Um usuário está em no máximo um.
    pub fn channel_of(&self, user_id: UserId) -> Option<ChannelId>;
    /// Conta apenas participantes confirmados e não-bot (INV-F2).
    pub fn human_count(&self, channel_id: ChannelId) -> usize;
    pub fn is_full(&self, channel_id: ChannelId) -> bool {
        self.human_count(channel_id) >= MAX_HUMAN_PARTICIPANTS
    }

    // ---------- mutação autoritativa: webhook ----------

    /// Insere ou confirma um participante. Se já existe um provisório para
    /// este usuário, ele é confirmado em vez de duplicado.
    pub fn webhook_participant_joined(
        &mut self,
        channel_id: ChannelId,
        user_id: UserId,
        sid: ParticipantSid,
    ) -> RoomChange;

    /// Remove um participante SE o sid bater com o registrado (INV-B2).
    /// Um sid diferente devolve `RoomChange` vazio.
    pub fn webhook_participant_left(
        &mut self,
        channel_id: ChannelId,
        user_id: UserId,
        sid: ParticipantSid,
    ) -> RoomChange;

    pub fn webhook_track_published(
        &mut self,
        channel_id: ChannelId,
        user_id: UserId,
        participant_sid: Option<ParticipantSid>,
        track_sid: TrackSid,
        source: TrackSource,
    ) -> RoomChange;

    /// Remove por SID. Um SID desconhecido devolve `RoomChange` vazio.
    pub fn webhook_track_unpublished(
        &mut self,
        channel_id: ChannelId,
        track_sid: &str,
    ) -> RoomChange;

    pub fn webhook_track_muted(
        &mut self,
        channel_id: ChannelId,
        track_sid: &str,
        muted: bool,
    ) -> RoomChange;

    // ---------- mutação autoritativa: reconcile ----------

    /// Força o canal a espelhar exatamente o que o LiveKit reporta.
    /// Preserva mute, deafen e a linha de música (estado só do Tupi).
    pub fn reconcile_room(
        &mut self,
        channel_id: ChannelId,
        participants: Vec<ReconciledParticipant>,
    ) -> RoomChange;

    /// Remove canais que o LiveKit não reporta mais. Chamado depois de
    /// `reconcile_room` para cada canal reportado.
    pub fn reconcile_prune(&mut self, live_channels: &HashSet<ChannelId>) -> Vec<RoomChange>;

    // ---------- dicas do cliente (não autoritativas) ----------

    /// Insere provisório, ou confirma com o sid se o cliente já o conhece.
    /// Nunca substitui um participante já confirmado.
    pub fn hint_joining(
        &mut self,
        channel_id: ChannelId,
        user_id: UserId,
        sid: Option<ParticipantSid>,
        is_bot: bool,
    ) -> RoomChange;

    /// Remove SOMENTE se provisório (INV-A1). Devolve
    /// `(RoomChange, needs_reconcile)`; quando o participante é confirmado a
    /// mudança é vazia e `needs_reconcile` é `true`.
    pub fn hint_leaving(
        &mut self,
        channel_id: ChannelId,
        user_id: UserId,
    ) -> (RoomChange, bool);

    /// Dica de track. Exige `track_sid`; valida dono em `unpublished`.
    pub fn hint_track(
        &mut self,
        channel_id: ChannelId,
        user_id: UserId,
        track_sid: TrackSid,
        source: TrackSource,
        published: bool,
    ) -> Result<RoomChange, HintError>;

    // ---------- estado só do Tupi ----------

    pub fn set_audio_state(
        &mut self,
        channel_id: ChannelId,
        user_id: UserId,
        muted: Option<bool>,
        deafened: Option<bool>,
    ) -> Result<RoomChange, HintError>;

    /// Linha sintética do bot de música (exceção a INV-B1).
    pub fn set_music_row(&mut self, channel_id: ChannelId, playing: bool) -> RoomChange;

    // ---------- manutenção ----------

    /// Remove provisórios vencidos (INV-A2). Chamar a cada tick do reconcile.
    pub fn expire_provisionals(&mut self) -> Vec<RoomChange>;

    /// Canal apagado do banco: encerra a sala.
    pub fn close_channel(&mut self, channel_id: ChannelId) -> RoomChange;

    /// Dedupe de webhook. `true` = já foi visto, descartar.
    pub fn is_duplicate_event(&mut self, key: &str) -> bool;
}

#[derive(Debug, PartialEq)]
pub enum HintError {
    NotInCall,
    NotTrackOwner,
    TrackNotFound,
}

pub struct ReconciledParticipant {
    pub user_id: UserId,
    pub sid: ParticipantSid,
    pub tracks: Vec<(TrackSid, TrackSource, bool /* muted */)>,
}
```

### 4.4 Semânticas que não podem ser alteradas

Estas são as regras que fazem o sistema convergir. Implementar exatamente.

**`webhook_participant_joined`:**

```
se existe participante P para user_id:
    se P.sid == Some(sid):            devolve vazio (reentrega)
    senão:                            P.sid = Some(sid); P.provisional_since = None
                                      version++; participants_updated += P
                                      (é uma reconexão OU confirmação de provisório)
senão:
    insere confirmado; version++; participants_added += novo
```

**`webhook_participant_left`:** (INV-B2, o coração da correção de RC-06)

```
se não existe participante P:                       devolve vazio
se P.sid é Some(outro) e outro != sid:              devolve vazio (obsoleto)
se P.sid é None (provisório):                       devolve vazio
                                                    (um left não pode se referir
                                                     a uma sessão que nunca existiu)
senão:
    remove P e TODAS as tracks cujo owner == user_id
    version++; participants_removed += user_id; tracks_removed += sids
    se participants ficou vazio: remove a sala; room_closed = true
```

**`webhook_track_published`:**

```
se tracks já contém track_sid:                      devolve vazio (reentrega)
se não existe participante para user_id:
    insere provisório para user_id (o webhook de track chegou antes do de join)
    version++; participants_added += provisório
insere track por track_sid; version++; tracks_added += track
```

Inserir o participante provisório quando o `track_published` chega antes do
`participant_joined` é obrigatório: sem isso a track ficaria órfã e o roster
mostraria um compartilhamento sem dono. O `participant_joined` que chegar
depois confirma o provisório pelo caminho normal.

**`webhook_track_unpublished`:**

```
se não existe track com esse sid:                   devolve vazio
remove; version++; tracks_removed += sid
```

Nada de procurar por dono e tipo. Só o SID. Essa é a correção de RC-03.

**`reconcile_room`:** (autoritativo)

```
live_ids = { p.user_id }
para cada participante local NÃO provisório e ausente de live_ids:
    remove ele e suas tracks; participants_removed; tracks_removed
para cada participante local PROVISÓRIO ausente de live_ids:
    manter se provisional_since é mais novo que PROVISIONAL_TTL, senão remover
para cada p em live:
    se não existe local: insere confirmado; participants_added
    senão se local.sid != Some(p.sid): atualiza sid; participants_updated
    (mute, deafen, is_bot, joined_at NUNCA são tocados)

live_tracks = união de p.tracks
para cada track local cujo sid não está em live_tracks E cuja source != Music:
    remove; tracks_removed
para cada (sid, source, muted) em live_tracks:
    se não existe local: insere; tracks_added
    senão se muted difere: atualiza; tracks_added (reenvia a linha inteira)

version++ SOMENTE se algo mudou   // INV-C2: reconcile em sincronia não infla versão
reconciled_at = Instant::now()    // sempre, mesmo sem mudança
```

Preservar mute e deafen é o comportamento que o código atual já tem
(`call_registry.rs:197-210`) e precisa continuar tendo. Preservar a linha
`Music` é o que impede o reconcile de apagar o "TOCANDO" do bot.

**`hint_leaving`:** (INV-A1, o coração da correção do sintoma 1)

```
se não existe participante:               devolve (vazio, false)
se provisório:                            remove; version++; devolve (change, false)
se confirmado:                            devolve (vazio, TRUE)
                                          // não remove; o chamador agenda reconcile
```

**`hint_track`:**

```
published:
    exige participante (confirmado ou provisório), senão Err(NotInCall)
    se já existe o sid: Ok(vazio)
    insere; version++; Ok(change)
unpublished:
    se não existe o sid: Err(TrackNotFound)
    se track.owner != user_id: Err(NotTrackOwner)     // INV-F1, corrige A1
    remove; version++; Ok(change)
```

**`expire_provisionals`:**

```
para cada sala, para cada participante provisório com
provisional_since mais velho que PROVISIONAL_TTL:
    remove; version++; participants_removed
    (se a sala esvaziar, remove a sala; room_closed = true)
```

**`is_duplicate_event`:**

```
se seen_events contém key: true
senão:
    insere; seen_order.push_back(key)
    enquanto seen_order.len() > 512:
        old = seen_order.pop_front(); seen_events.remove(old)
    false
```

### 4.5 `server/src/ws/hub.rs`

```rust
pub struct Hub {
    conns: RwLock<HashMap<Uuid, HashMap<Uuid, ConnHandle>>>,
    /// Registro legado; removido em SPEC-018.
    pub calls: RwLock<CallRegistry>,
    /// Registro v2, autoridade a partir de SPEC-004.
    pub voice: RwLock<VoiceRegistry>,
    pub activities: RwLock<ActivityRegistry>,
    statuses: RwLock<HashMap<Uuid, String>>,
}
```

Nesta spec o campo é criado e fica vazio. SPEC-004 passa a escrevê-lo.

### 4.6 `server/src/ws/protocol.rs` — DTOs v2

```rust
#[derive(Debug, Serialize, Clone)]
pub struct VoiceParticipantDto {
    pub user_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub participant_sid: Option<String>,
    pub muted: bool,
    pub deafened: bool,
    pub is_bot: bool,
    pub provisional: bool,
    pub joined_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize, Clone)]
pub struct VoiceTrackDto {
    pub track_sid: String,
    pub owner: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_sid: Option<String>,
    pub source: String,
    pub muted: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct VoiceRoomDto {
    pub channel_id: Uuid,
    pub version: u64,
    pub participants: Vec<VoiceParticipantDto>,
    pub tracks: Vec<VoiceTrackDto>,
}

#[derive(Debug, Serialize)]
pub struct VoiceRoomState {
    pub full: bool,
    pub rooms: Vec<VoiceRoomDto>,
}

#[derive(Debug, Serialize, Clone)]
pub struct VoiceRoomDelta {
    pub channel_id: Uuid,
    pub version: u64,
    pub previous_version: u64,
    pub participants_added: Vec<VoiceParticipantDto>,
    pub participants_updated: Vec<VoiceParticipantDto>,
    pub participants_removed: Vec<Uuid>,
    pub tracks_added: Vec<VoiceTrackDto>,
    pub tracks_removed: Vec<String>,
    pub reason: String,
}

#[derive(Debug, Deserialize)]
pub struct VoiceRoomRequest {
    #[serde(default)]
    pub channel_ids: Vec<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct VoicePresenceHint {
    pub channel_id: Uuid,
    /// "joining" | "leaving"
    pub state: String,
    #[serde(default)]
    pub participant_sid: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct VoiceTrackHint {
    pub channel_id: Uuid,
    pub track_sid: String,
    pub source: String,
    /// "published" | "unpublished"
    pub state: String,
}
```

Ordenação obrigatória: ao serializar `participants` e `tracks`, ordenar por
`user_id` e por `track_sid` respectivamente. Um `HashMap` tem ordem não
determinística, e sem ordenação dois snapshots idênticos parecem diferentes
para qualquer diff, teste ou olho humano.

## 5. Contratos de dados

Definidos em `05-protocol-spec.md` §2. Nesta spec apenas os tipos Rust
existem; nada é emitido ainda (isso é SPEC-005).

## 6. Casos de borda a tratar

1. `track_published` chega antes de `participant_joined`: cria provisório
   (§4.4).
2. `participant_left` de sid obsoleto: ignorado, com contador
   `webhooks_ignored_stale`.
3. `participant_left` de um provisório: ignorado. Um `left` refere-se a uma
   sessão real; um provisório nunca teve sessão.
4. `track_unpublished` de sid desconhecido: ignorado, sem erro.
5. Reentrega exata do mesmo webhook: `is_duplicate_event` corta antes de
   chegar ao registry.
6. Reconcile com a lista vazia para um canal: todos os confirmados saem; os
   provisórios recentes ficam; se sobrar zero, a sala é removida.
7. Reconcile durante uma janela em que o cliente acabou de mandar `hint_joining`:
   o provisório recente sobrevive (é por isso que a regra usa
   `PROVISIONAL_TTL`, não remoção imediata).
8. Dois usuários com o mesmo `user_id` em canais diferentes: impossível por
   `channel_of`, mas se acontecer (bug em outro lugar), `channel_of` devolve o
   primeiro encontrado em ordem de iteração. Documentar que o chamador não deve
   depender disso, e que `reconcile_room` corrige naturalmente.
9. `version` em `u64`: sem tratamento de overflow. A 1000 mutações por segundo
   levaria 584 milhões de anos.
10. Sala com só o bot: continua existindo (o bot pode estar tocando sozinho por
    projeto, `handler.rs:1238-1239`). `human_count` devolve 0 e `is_full` é
    falso.
11. `set_music_row(false)` numa sala inexistente: devolve vazio, sem criar sala.
12. `close_channel` numa sala inexistente: devolve vazio.

## 7. Critérios de aceite

- **Dado** um `webhook_participant_joined` com sid S1 seguido de
  `webhook_participant_left` com sid S0, **então** o participante permanece e o
  `RoomChange` do left é vazio.
- **Dado** uma track publicada com sid TR_1, despublicada, e publicada com
  TR_2, **então** o registry contém exatamente TR_2 e a `version` subiu 3.
- **Dado** que TR_2 é publicada **antes** de TR_1 ser despublicada, **então** o
  registry final contém apenas TR_2.
- **Dado** um participante confirmado, **quando** `hint_leaving` é chamado,
  **então** ele permanece, o `RoomChange` é vazio, e `needs_reconcile` é `true`.
- **Dado** um participante provisório, **quando** `hint_leaving` é chamado,
  **então** ele é removido e a `version` sobe.
- **Dado** um provisório com mais de 10 s, **quando** `expire_provisionals`
  roda, **então** ele é removido.
- **Dado** um `reconcile_room` com exatamente o mesmo conteúdo, **então** a
  `version` **não** muda e `reconciled_at` é atualizado.
- **Dado** um reconcile, **então** `muted`, `deafened` e a linha `Music`
  sobrevivem.
- **Dado** `hint_track(unpublished)` de um usuário que não é dono da track,
  **então** o resultado é `Err(NotTrackOwner)` e o registry não muda.
- **Dado** dois snapshots do mesmo estado, **então** a serialização é
  byte-idêntica (ordenação determinística).
- **Dado** cada variante de `ChangeReason`, **então** sua serialização casa
  exatamente com a lista de `05-protocol-spec.md` §2.2.

## 8. Como testar

### Automatizado — `#[cfg(test)]` em `voice_registry.rs`

Os 18 testes U-01 a U-18 de `07-test-plan.md` §1. Nenhum precisa de I/O.

Mais um específico desta spec:

```rust
#[test]
fn change_reason_serializes_to_protocol_values() {
    let expected = [
        (ChangeReason::WebhookParticipantJoined, "webhook.participant_joined"),
        // ... todas as 14 variantes ...
    ];
    for (reason, wire) in expected {
        assert_eq!(serde_json::to_value(reason).unwrap(), serde_json::json!(wire));
    }
}
```

Atenção: `#[serde(rename_all = "snake_case")]` produz
`webhook_participant_joined`, com sublinhado, não `webhook.participant_joined`
com ponto. Portanto **usar `#[serde(rename = "...")]` explícito em cada
variante**, com o valor exato da tabela do protocolo. O teste acima é o que
impede esse erro de passar.

### Manual

Nenhum. Esta spec não muda comportamento observável; o registry novo ainda não
é lido por ninguém. A verificação é inteiramente por teste unitário, o que é
adequado para uma estrutura de dados pura.

## 9. Riscos e rollback

| Risco | Mitigação |
|---|---|
| O registry novo diverge do antigo enquanto os dois coexistem | Nesta spec o novo não é escrito por ninguém; SPEC-004 faz a migração de escritores de uma vez |
| Memória dobrada por ter dois registros | O antigo tem no máximo dezenas de entradas; o dobro disso é irrelevante |
| `ChangeReason` serializando errado | Teste dedicado acima |
| Ordem não determinística de `HashMap` vazando para o wire | Ordenação obrigatória na serialização, com teste |

**Rollback:** `git revert`. Código novo, não referenciado por nenhum caminho de
execução; reverter é seguro por construção.

## 10. Fora de escopo

- Não remover nem modificar `CallRegistry` (SPEC-018).
- Não ligar o webhook ao registry novo (SPEC-004).
- Não emitir nenhuma op de rede (SPEC-005).
- Não tocar em `handler.rs` além do que SPEC-002 já fez.
- Não implementar `viewers` de stream: no modelo SFU, quem assina é decidido
  pelo cliente direto no LiveKit, e o servidor não precisa saber. O campo
  `viewers` do `CallRegistry` (`call_registry.rs:42`) é resíduo do mesh e não é
  portado.
