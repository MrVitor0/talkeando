//! Production state inspection without a redeploy (INV-G2). Restricted to the
//! community owner: it exposes identities and client versions.
//!
//! Body contract: tupi-v2-refactor/06-observability.md §4. Several per-room and
//! per-participant fields (`version`, `reconciled_at_ago_ms`, `participant_sid`,
//! `provisional`, `joined_at`) are placeholders until SPEC-003 replaces the v1
//! `CallRegistry` with the versioned, SID-addressed `VoiceRegistry`. The
//! endpoint keeps its shape across specs on purpose.

use std::collections::{BTreeMap, HashSet};
use std::time::Duration;

use axum::{
    extract::{Query, State},
    Json,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    auth::AuthUser,
    db,
    error::{AppError, AppResult},
    state::AppState,
};

#[derive(Debug, Deserialize)]
pub struct DebugQuery {
    /// `live=1` queries LiveKit and returns the diff against the registry.
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
    if !matches!(
        db::is_community_owner(&state.pool, community_id, auth.user.id).await,
        Ok(true)
    ) {
        return Err(AppError::Forbidden);
    }

    // ---- rooms: current VoiceRegistry state, projected into the §4 shape ----
    let (channel_ids, rooms_raw): (Vec<Uuid>, Vec<RawRoom>) = {
        let voice = state.hub.voice.read().await;
        let mut channel_ids = voice.all_channel_ids();
        channel_ids.sort();
        let rooms_raw = channel_ids
            .iter()
            .filter_map(|channel_id| {
                let room = voice.room(*channel_id)?;
                Some(RawRoom {
                    channel_id: *channel_id,
                    version: room.version,
                    reconciled_at_ago_ms: room
                        .reconciled_at
                        .map(|at| at.elapsed().as_millis() as u64),
                    participants: room
                        .participants
                        .values()
                        .map(|p| RawParticipant {
                            user_id: p.user_id,
                            participant_sid: p.sid.clone(),
                            provisional: p.is_provisional(),
                            muted: p.muted,
                            deafened: p.deafened,
                            is_bot: p.is_bot,
                            joined_at: p.joined_at,
                        })
                        .collect(),
                    tracks: room
                        .tracks
                        .values()
                        .map(|t| RawTrack {
                            track_sid: t.sid.clone(),
                            owner: t.owner,
                            source: t.source.as_wire().to_string(),
                            muted: t.muted,
                        })
                        .collect(),
                })
            })
            .collect();
        (channel_ids, rooms_raw)
    };

    let channel_names = db::channel_names_for(&state.pool, &channel_ids)
        .await
        .unwrap_or_default();
    let participant_ids: Vec<Uuid> = rooms_raw
        .iter()
        .flat_map(|room| room.participants.iter().map(|p| p.user_id))
        .collect();
    let display_names = db::display_names_for(&state.pool, &participant_ids)
        .await
        .unwrap_or_default();

    let rooms: Vec<serde_json::Value> = rooms_raw
        .iter()
        .map(|room| {
            serde_json::json!({
                "channel_id": room.channel_id,
                "channel_name": channel_names.get(&room.channel_id),
                "version": room.version,
                "reconciled_at_ago_ms": room.reconciled_at_ago_ms,
                "participants": room.participants.iter().map(|p| serde_json::json!({
                    "user_id": p.user_id,
                    "display_name": display_names.get(&p.user_id),
                    "participant_sid": p.participant_sid,
                    "provisional": p.provisional,
                    "muted": p.muted,
                    "deafened": p.deafened,
                    "is_bot": p.is_bot,
                    "joined_at": p.joined_at,
                })).collect::<Vec<_>>(),
                "tracks": room.tracks.iter().map(|t| serde_json::json!({
                    "track_sid": t.track_sid,
                    "owner": t.owner,
                    "source": t.source,
                    "muted": t.muted,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();

    // ---- connections: who is on which protocol version, right now ----
    // Grouped by (user, protocol_version, client_version) so two sockets of
    // the same user on different versions each get a row (the version-skew
    // question this block exists to answer).
    let mut grouped: BTreeMap<(Uuid, u8, String), u64> = BTreeMap::new();
    for (user_id, meta) in state.hub.connection_meta().await {
        *grouped
            .entry((user_id, meta.protocol_version, meta.client_version))
            .or_insert(0) += 1;
    }
    let connections: Vec<serde_json::Value> = grouped
        .into_iter()
        .map(|((user_id, protocol_version, client_version), connection_count)| {
            serde_json::json!({
                "user_id": user_id,
                "connection_count": connection_count,
                "protocol_version": protocol_version,
                "client_version": client_version,
            })
        })
        .collect();

    let mut body = serde_json::json!({
        "server_version": crate::SERVER_VERSION,
        "uptime_seconds": state.started_at.elapsed().as_secs(),
        "metrics": state.voice_metrics.snapshot(),
        "rooms": rooms,
        "connections": connections,
    });

    // ---- live=1: diff the registry against LiveKit ----
    if query.live == Some(1) {
        let obj = body.as_object_mut().expect("body is an object");
        if state.config.livekit_url.is_none() {
            obj.insert("livekit_diff".into(), serde_json::Value::Null);
            obj.insert("live_error".into(), "LiveKit is not configured".into());
        } else if !state.should_run_debug_live(Duration::from_secs(10)).await {
            obj.insert("live_skipped".into(), "rate_limited".into());
        } else {
            match crate::livekit::room_snapshot(&state.config).await {
                Ok(snapshot) => {
                    obj.insert("livekit_diff".into(), build_livekit_diff(snapshot, &rooms_raw));
                }
                Err(error) => {
                    obj.insert("livekit_diff".into(), serde_json::Value::Null);
                    obj.insert("live_error".into(), error.to_string().into());
                }
            }
        }
    }

    Ok(Json(body))
}

struct RawRoom {
    channel_id: Uuid,
    version: u64,
    reconciled_at_ago_ms: Option<u64>,
    participants: Vec<RawParticipant>,
    tracks: Vec<RawTrack>,
}

struct RawParticipant {
    user_id: Uuid,
    participant_sid: Option<String>,
    provisional: bool,
    muted: bool,
    deafened: bool,
    is_bot: bool,
    joined_at: chrono::DateTime<chrono::Utc>,
}

struct RawTrack {
    track_sid: String,
    owner: Uuid,
    source: String,
    muted: bool,
}

/// Per-channel set difference between LiveKit's live view and the registry.
/// An empty `rooms` array means the server and the SFU agree completely — the
/// expected result in a healthy system.
fn build_livekit_diff(
    snapshot: Vec<(String, Vec<crate::livekit::RoomParticipant>)>,
    registry: &[RawRoom],
) -> serde_json::Value {
    let mut lk: BTreeMap<Uuid, (HashSet<Uuid>, HashSet<String>)> = BTreeMap::new();
    for (room, participants) in snapshot {
        let Ok(channel_id) = Uuid::parse_str(&room) else { continue };
        let entry = lk.entry(channel_id).or_default();
        for p in participants {
            if let Ok(user_id) = Uuid::parse_str(&p.identity) {
                entry.0.insert(user_id);
            }
            for (track_sid, _source, _muted) in p.tracks {
                entry.1.insert(track_sid);
            }
        }
    }

    let mut reg: BTreeMap<Uuid, (HashSet<Uuid>, HashSet<String>)> = BTreeMap::new();
    for room in registry {
        let entry = reg.entry(room.channel_id).or_default();
        let (participants, tracks) = (&room.participants, &room.tracks);
        for p in participants {
            entry.0.insert(p.user_id);
        }
        for t in tracks {
            entry.1.insert(t.track_sid.clone());
        }
    }

    let all_channels: HashSet<Uuid> = lk.keys().chain(reg.keys()).copied().collect();
    let mut diff_rooms = Vec::new();
    for channel_id in all_channels {
        let (lk_p, lk_t) = lk.get(&channel_id).cloned().unwrap_or_default();
        let (reg_p, reg_t) = reg.get(&channel_id).cloned().unwrap_or_default();
        let only_lk_p: Vec<Uuid> = lk_p.difference(&reg_p).copied().collect();
        let only_reg_p: Vec<Uuid> = reg_p.difference(&lk_p).copied().collect();
        let only_lk_t: Vec<String> = lk_t.difference(&reg_t).cloned().collect();
        let only_reg_t: Vec<String> = reg_t.difference(&lk_t).cloned().collect();
        if only_lk_p.is_empty() && only_reg_p.is_empty() && only_lk_t.is_empty() && only_reg_t.is_empty() {
            continue;
        }
        diff_rooms.push(serde_json::json!({
            "channel_id": channel_id,
            "only_in_livekit": { "participants": only_lk_p, "tracks": only_lk_t },
            "only_in_registry": { "participants": only_reg_p, "tracks": only_reg_t },
        }));
    }

    serde_json::json!({
        "queried_at": chrono::Utc::now(),
        "rooms": diff_rooms,
    })
}
