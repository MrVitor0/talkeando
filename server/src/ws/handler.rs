use std::{
    collections::HashSet,
    time::{Duration, Instant},
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use uuid::Uuid;

const MUSIC_BOT_ID: Uuid = Uuid::from_u128(1);

/// How often the server pings an idle socket, and how long it tolerates
/// silence before treating the connection as dead. Without this a client
/// that vanishes uncleanly (Wi-Fi drop, laptop sleep, killed process) would
/// sit in `conns` — and stay "online" for everyone — until the OS TCP
/// keepalive eventually reaped it (hours). The .NET/browser client answers
/// WebSocket Pings at the transport layer, so a live-but-idle client keeps
/// itself marked online for free.
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(60);

use crate::{
    auth::authenticate_token,
    db,
    state::AppState,
    ws::{
        call_registry::CallOpError,
        protocol::*,
    },
};

pub async fn ws_upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    // Forward outbound queue -> actual socket sink. Keeps the socket write
    // half owned by exactly one task, avoiding interleaved writes.
    let forward_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sender.send(msg).await.is_err() {
                break;
            }
        }
    });

    // WS-FR-001: client must send auth.hello within 10s of connecting.
    let hello = tokio::time::timeout(Duration::from_secs(10), receiver.next()).await;
    let user = match hello {
        Ok(Some(Ok(Message::Text(text)))) => match serde_json::from_str::<InboundEnvelope>(&text) {
            Ok(env) if env.op == "auth.hello" => {
                match serde_json::from_value::<AuthHello>(env.data) {
                    Ok(AuthHello { token }) if token == state.config.music_bot_token => Some((music_bot_user(), Uuid::nil())),
                    Ok(AuthHello { token }) => match authenticate_token(&state.pool, &token).await {
                        Ok((u, s)) => Some((u, s)),
                        Err(error) => {
                            if !matches!(error, crate::error::AppError::Unauthorized) {
                                tracing::error!(%error, "database error during ws handshake");
                            }
                            None
                        }
                    },
                    Err(_) => None,
                }
            }
            _ => None,
        },
        _ => None,
    };

    let Some((user, _session_id)) = user else {
        let _ = tx.send(Message::Text(
            serde_json::to_string(&OutboundEnvelope::new(
                "auth.rejected",
                serde_json::json!({ "reason": "invalid_or_missing_token" }),
            ))
            .unwrap(),
        ));
        let _ = tx.send(Message::Close(None));
        drop(tx);
        let _ = forward_task.await;
        return;
    };

    let user_id = user.id;
    tracing::info!(%user_id, "ws connected");

    let was_online = state.hub.is_online(user_id).await;
    let connection_id = state.hub.register(user_id, tx.clone()).await;
    state.advance_presence_epoch(user_id).await;
    let cancelled_offline_grace = state.cancel_offline_grace(user_id).await;

    state
        .hub
        .send_to_connection(
            user_id,
            connection_id,
            OutboundEnvelope::new(
                "auth.ok",
                AuthOk {
                    user_id,
                    username: user.username.clone(),
                    display_name: user.display_name.clone(),
                },
            ),
        )
        .await;

    let members = match db::related_member_ids(&state.pool, user_id).await {
        Ok(members) => members,
        Err(error) => {
            tracing::error!(%user_id, %error, "failed to resolve presence snapshot members");
            vec![user_id]
        }
    };
    let mut entries = Vec::with_capacity(members.len());
    for member_id in &members {
        entries.push(PresenceEntry {
            user_id: *member_id,
            status: state.hub.status_for(*member_id).await,
        });
    }
    let snapshot = PresenceSnapshot { users: entries };
    state
        .hub
        .send_to_connection(user_id, connection_id, OutboundEnvelope::new("presence.snapshot", snapshot))
        .await;
    // ACT-FR-005: right after presence.snapshot, hand this connection the
    // current activity of every member who has any (absent = empty list),
    // each game enriched with its lifetime playtime (ACT-FR-032).
    let mut activity_users = state.hub.activities.read().await.snapshot_for(&members);
    for entry in activity_users.iter_mut() {
        enrich_playtime(&state, entry.user_id, &mut entry.activities).await;
    }
    state
        .hub
        .send_to_connection(
            user_id,
            connection_id,
            OutboundEnvelope::new("activity.snapshot", ActivitySnapshot { users: activity_users }),
        )
        .await;
    send_voice_rooms_snapshot(&state, user_id, connection_id).await;
    if !was_online && !cancelled_offline_grace {
        broadcast_presence_update(&state, user_id, "online").await;
    }

    let mut joined_calls: HashSet<Uuid> = HashSet::new();

    // Application-level heartbeat: any inbound frame (including the Pong the
    // client sends in reply to our Ping) refreshes `last_seen`; if nothing
    // arrives for HEARTBEAT_TIMEOUT we drop the socket so the disconnect
    // path below runs and the user goes offline.
    let mut last_seen = Instant::now();
    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    heartbeat.tick().await; // consume the immediate first tick

    loop {
        tokio::select! {
            incoming = receiver.next() => {
                let Some(msg) = incoming else { break };
                let msg = match msg {
                    Ok(m) => m,
                    Err(_) => break,
                };
                last_seen = Instant::now();
                match msg {
                    Message::Text(text) => {
                        dispatch(&state, user_id, &text, &mut joined_calls).await;
                    }
                    Message::Ping(payload) => {
                        let _ = state
                            .hub
                            .send_to_raw(user_id, Message::Pong(payload))
                            .await;
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            _ = heartbeat.tick() => {
                if last_seen.elapsed() > HEARTBEAT_TIMEOUT {
                    tracing::info!(%user_id, "ws heartbeat timeout; dropping dead connection");
                    break;
                }
                if tx.send(Message::Ping(Vec::new())).is_err() {
                    break;
                }
            }
        }
    }

    // Connection ended: unwind presence + any calls this user was in.
    let was_last_connection = state.hub.unregister(user_id, connection_id).await;
    if !was_last_connection {
        tracing::info!(%user_id, "ws disconnected; another connection remains active");
        let _ = forward_task.await;
        return;
    }
    let channels: Vec<Uuid> = joined_calls.into_iter().collect();
    let disconnect_epoch = state.advance_presence_epoch(user_id).await;
    state.begin_offline_grace(user_id).await;
    let delayed_state = state.clone();
    tokio::spawn(async move {
        // Grace window so a page refresh / brief network blip doesn't flap the
        // member list. A genuine disconnect still clears well inside this once
        // the heartbeat above has torn the dead socket down.
        tokio::time::sleep(Duration::from_secs(8)).await;
        if delayed_state.hub.is_online(user_id).await
            || !delayed_state.presence_epoch_is_current(user_id, disconnect_epoch).await
        {
            return;
        }
        if !delayed_state.finish_offline_grace(user_id).await {
            return;
        }
        for channel_id in channels {
            teardown_call_membership(&delayed_state, channel_id, user_id, "disconnected").await;
        }
        teardown_spectator_subscriptions(&delayed_state, user_id).await;
        // ACT-FR-006: clear this user's activity in the same grace window,
        // and close any playtime rows left open (ACT-FR-031).
        if delayed_state.hub.activities.write().await.clear(user_id) {
            broadcast_activity_update(&delayed_state, user_id, Vec::new()).await;
        }
        // Drop any "busy" override so a later reconnect comes back as plain
        // online; the "offline" broadcast below already covers the visible state.
        delayed_state.hub.clear_status(user_id).await;
        if let Err(error) = db::close_all_game_sessions(&delayed_state.pool, user_id).await {
            tracing::warn!(%user_id, %error, "failed to close game sessions on disconnect");
        }
        broadcast_presence_update(&delayed_state, user_id, "offline").await;
        tracing::info!(%user_id, "ws disconnect grace period elapsed");
    });
    tracing::info!(%user_id, "ws disconnected; grace period started");
    let _ = forward_task.await;
}

fn music_bot_user() -> db::User {
    db::User {
        id: MUSIC_BOT_ID, username: "tupi-musica".into(), display_name: "Tupi Música".into(),
        password_hash: String::new(), avatar_color: Some("#5865f2".into()), avatar_storage_path: None,
        avatar_content_type: None, profile_tag: Some("BOT".into()), profile_badge_storage_path: None,
        profile_badge_content_type: None, name_color: Some("#5865f2".into()), created_at: chrono::Utc::now(),
    }
}

async fn broadcast_presence_update(state: &AppState, user_id: Uuid, status: &str) {
    match db::related_member_ids(&state.pool, user_id).await {
        Ok(user_ids) => state.hub.broadcast_to(
            &user_ids,
            OutboundEnvelope::new(
                "presence.update",
                PresenceUpdate { user_id, status: status.to_string() },
            ),
        ).await,
        Err(error) => tracing::error!(%user_id, %error, "failed to resolve presence recipients"),
    }
}

async fn broadcast_activity_update(state: &AppState, user_id: Uuid, activities: Vec<Activity>) {
    match db::related_member_ids(&state.pool, user_id).await {
        Ok(user_ids) => {
            state
                .hub
                .broadcast_to(
                    &user_ids,
                    OutboundEnvelope::new("activity.update", ActivityUpdate { user_id, activities }),
                )
                .await
        }
        Err(error) => tracing::error!(%user_id, %error, "failed to resolve activity recipients"),
    }
}

/// ACT-FR-001/003/004: fire-and-forget rich-presence report. Sanitize the
/// client's list, replace what we hold for this user, and broadcast to the
/// community (including the sender, so multi-device clients converge) only
/// when the sanitized state actually changed. On a change we also reconcile
/// the persistent playtime ledger (ACT-FR-031) and enrich each game with its
/// lifetime aggregates before broadcasting (ACT-FR-032).
async fn handle_activity_report(state: &AppState, user_id: Uuid, data: ActivityReport) {
    let (mut activities, dropped) = crate::ws::activity::ActivityRegistry::sanitize(data.activities);
    if dropped > 0 {
        tracing::warn!(%user_id, dropped, "activity.report had items dropped by validation");
    }
    let previous = state.hub.activities.read().await.get(user_id);
    let changed = state.hub.activities.write().await.set(user_id, activities.clone());
    if !changed {
        return;
    }
    reconcile_game_sessions(state, user_id, &previous, &activities).await;
    enrich_playtime(state, user_id, &mut activities).await;
    tracing::debug!(%user_id, count = activities.len(), "activity.update");
    broadcast_activity_update(state, user_id, activities).await;
}

/// Open a playtime row for each game that just appeared in the user's report
/// and close the row for each one that just disappeared (ACT-FR-031).
async fn reconcile_game_sessions(
    state: &AppState,
    user_id: Uuid,
    previous: &[Activity],
    current: &[Activity],
) {
    use crate::ws::activity::game_key;
    use std::collections::HashMap;
    let prev: HashMap<String, ()> =
        previous.iter().filter_map(|a| game_key(a).map(|k| (k, ()))).collect();
    let curr: HashMap<String, String> =
        current.iter().filter_map(|a| game_key(a).map(|k| (k, a.name.clone()))).collect();
    for (key, name) in &curr {
        if !prev.contains_key(key) {
            if let Err(error) = db::open_game_session(&state.pool, user_id, key, name).await {
                tracing::warn!(%user_id, key, %error, "failed to open game session");
            }
        }
    }
    for key in prev.keys() {
        if !curr.contains_key(key) {
            if let Err(error) = db::close_game_session(&state.pool, user_id, key).await {
                tracing::warn!(%user_id, key, %error, "failed to close game session");
            }
        }
    }
}

/// Fill `total_seconds` / `last_played_at` / `is_new` on every `kind ==
/// "playing"` activity from the playtime ledger (ACT-FR-032). `user_id` is
/// the member the activities belong to, not necessarily the viewer.
async fn enrich_playtime(state: &AppState, user_id: Uuid, activities: &mut [Activity]) {
    use crate::ws::activity::game_key;
    for activity in activities.iter_mut() {
        let Some(key) = game_key(activity) else { continue };
        match db::game_stats(&state.pool, user_id, &key).await {
            Ok(stats) => {
                activity.total_seconds = Some(stats.total_seconds);
                activity.last_played_at = stats.last_played_at.map(|time| time.to_rfc3339());
                activity.is_new = Some(stats.is_new);
            }
            Err(error) => tracing::warn!(%user_id, key, %error, "failed to load game stats"),
        }
    }
}

async fn teardown_call_membership(
    state: &AppState,
    channel_id: Uuid,
    user_id: Uuid,
    reason: &str,
) {
    let removed_streams = {
        let mut calls = state.hub.calls.write().await;
        if !calls.is_participant(channel_id, user_id) {
            return;
        }
        calls.leave(channel_id, user_id)
    };
    let remaining = state.hub.calls.read().await.participant_ids(channel_id);
    state
        .hub
        .broadcast_to(
            &remaining,
            OutboundEnvelope::new(
                "call.peer_left",
                CallPeerLeft {
                    channel_id,
                    user_id,
                    reason: reason.to_string(),
                    is_bot: user_id == MUSIC_BOT_ID,
                },
            ),
        )
        .await;
    for stream_id in removed_streams {
        state
            .hub
            .broadcast_to(
                &remaining,
                OutboundEnvelope::new(
                    "stream.unpublished",
                    StreamUnpublished { channel_id, stream_id },
                ),
        )
        .await;
    }

    // The audio source lives on the DJ's client. If that client goes away,
    // remove the virtual bot too rather than leaving a misleading presence.
    let dj_left = {
        let mut djs = state.hub.music_djs.write().await;
        if djs.get(&channel_id).copied() == Some(user_id) { djs.remove(&channel_id); true } else { false }
    };
    if dj_left && state.hub.calls.read().await.is_participant(channel_id, MUSIC_BOT_ID) {
        state.hub.calls.write().await.leave(channel_id, MUSIC_BOT_ID);
        let recipients = state.hub.calls.read().await.participant_ids(channel_id);
        state.hub.broadcast_to(&recipients, OutboundEnvelope::new("call.peer_left", CallPeerLeft {
            channel_id, user_id: MUSIC_BOT_ID, reason: "dj_left".into(), is_bot: true,
        })).await;
    }

    broadcast_voice_roster(state, channel_id).await;
}

/// A disconnecting client may have been spectating streams in channels it
/// never joined (hover previews). Drop it from every stream's viewer set and
/// tell the affected owners so they stop sending.
async fn teardown_spectator_subscriptions(state: &AppState, user_id: Uuid) {
    let affected = {
        let mut calls = state.hub.calls.write().await;
        calls.remove_viewer_globally(user_id)
    };
    for (channel_id, stream_id, owner) in affected {
        state
            .hub
            .send_to(
                owner,
                OutboundEnvelope::new(
                    "stream.unsubscribed",
                    StreamUnsubscribed { channel_id, stream_id, subscriber: user_id },
                ),
            )
            .await;
    }
}

async fn dispatch(state: &AppState, user_id: Uuid, text: &str, joined_calls: &mut HashSet<Uuid>) {
    let env = match serde_json::from_str::<InboundEnvelope>(text) {
        Ok(e) => e,
        Err(e) => {
            state
                .hub
                .send_to(
                    user_id,
                    OutboundEnvelope::error("bad_request", format!("malformed envelope: {e}"), None),
                )
                .await;
            return;
        }
    };

    macro_rules! parse_or_reject {
        ($ty:ty) => {
            match serde_json::from_value::<$ty>(env.data.clone()) {
                Ok(v) => v,
                Err(e) => {
                    state
                        .hub
                        .send_to(
                            user_id,
                            OutboundEnvelope::error(
                                "bad_request",
                                format!("invalid payload for {}: {e}", env.op),
                                None,
                            ),
                        )
                        .await;
                    return;
                }
            }
        };
    }

    match env.op.as_str() {
        "chat.message.create" => {
            let data: ChatMessageCreate = parse_or_reject!(ChatMessageCreate);
            handle_chat_create(state, user_id, data).await;
        }
        "chat.message.edit" => {
            let data: ChatMessageEdit = parse_or_reject!(ChatMessageEdit);
            handle_chat_edit(state, user_id, data).await;
        }
        "chat.message.delete" => {
            let data: ChatMessageDelete = parse_or_reject!(ChatMessageDelete);
            handle_chat_delete(state, user_id, data).await;
        }
        "activity.report" => {
            let data: ActivityReport = parse_or_reject!(ActivityReport);
            handle_activity_report(state, user_id, data).await;
        }
        "presence.set" => {
            let data: PresenceSet = parse_or_reject!(PresenceSet);
            let status = if data.status == "busy" { "busy" } else { "online" };
            state.hub.set_status(user_id, status).await;
            broadcast_presence_update(state, user_id, status).await;
        }
        "chat.typing" => {
            let data: ChatTyping = parse_or_reject!(ChatTyping);
            if let Ok(Some(channel)) = db::channel_if_member(&state.pool, data.channel_id, user_id).await {
                if channel.kind == "text" {
                    broadcast_to_community(state, channel.community_id, OutboundEnvelope::new(
                        "chat.typing",
                        serde_json::json!({ "channel_id": data.channel_id, "user_id": user_id }),
                    )).await;
                }
            }
        }
        "call.join" => {
            let data: CallJoin = parse_or_reject!(CallJoin);
            handle_call_join(state, user_id, data, joined_calls).await;
        }
        "call.leave" => {
            let data: CallLeave = parse_or_reject!(CallLeave);
            joined_calls.remove(&data.channel_id);
            teardown_call_membership(state, data.channel_id, user_id, "left").await;
        }
        "call.state.update" => {
            let data: CallStateUpdate = parse_or_reject!(CallStateUpdate);
            handle_call_state_update(state, user_id, data).await;
        }
        "voice.move_member" => {
            let data: VoiceMoveMember = parse_or_reject!(VoiceMoveMember);
            handle_voice_move_member(state, user_id, data).await;
        }
        "voice.disconnect_member" => {
            let data: VoiceDisconnectMember = parse_or_reject!(VoiceDisconnectMember);
            handle_voice_disconnect_member(state, user_id, data).await;
        }
        "rtc.offer" => {
            let data: RtcOffer = parse_or_reject!(RtcOffer);
            relay_rtc(state, user_id, data.channel_id, data.to, "rtc.offer", data).await;
        }
        "rtc.answer" => {
            let data: RtcAnswer = parse_or_reject!(RtcAnswer);
            relay_rtc(state, user_id, data.channel_id, data.to, "rtc.answer", data).await;
        }
        "rtc.ice" => {
            let data: RtcIce = parse_or_reject!(RtcIce);
            relay_rtc(state, user_id, data.channel_id, data.to, "rtc.ice", data).await;
        }
        "rtc.connection_state" => {
            let data: RtcConnectionState = parse_or_reject!(RtcConnectionState);
            tracing::info!(%user_id, to = %data.to, channel_id = %data.channel_id, state = %data.state, "rtc connection state");
        }
        "stream.publish" => {
            let data: StreamPublish = parse_or_reject!(StreamPublish);
            handle_stream_publish(state, user_id, data).await;
        }
        "stream.unpublish" => {
            let data: StreamUnpublish = parse_or_reject!(StreamUnpublish);
            handle_stream_unpublish(state, user_id, data).await;
        }
        "stream.subscribe" => {
            let data: StreamSubscribe = parse_or_reject!(StreamSubscribe);
            handle_stream_subscribe(state, user_id, data).await;
        }
        "stream.unsubscribe" => {
            let data: StreamUnsubscribe = parse_or_reject!(StreamUnsubscribe);
            handle_stream_unsubscribe(state, user_id, data).await;
        }
        "music.command" => {
            let data: MusicCommand = parse_or_reject!(MusicCommand);
            handle_music_command(state, user_id, data).await;
        }
        "device.list_changed" => {
            let data: DeviceListChanged = parse_or_reject!(DeviceListChanged);
            tracing::debug!(%user_id, summary = ?data.summary, "device list changed");
        }
        other => {
            state
                .hub
                .send_to(
                    user_id,
                    OutboundEnvelope::error("unknown_op", format!("unknown op: {other}"), None),
                )
                .await;
        }
    }
}

async fn handle_music_command(state: &AppState, user_id: Uuid, data: MusicCommand) {
    let participants = state.hub.calls.read().await.participant_ids(data.voice_channel_id);
    if !participants.contains(&user_id) {
        state.hub.send_to(user_id, OutboundEnvelope::error("forbidden", "entre no canal de voz antes de controlar o bot", None)).await;
        return;
    }
    if data.command == "play" && data.query.as_deref().unwrap_or("").trim().is_empty() {
        state.hub.send_to(user_id, OutboundEnvelope::error("validation_error", "use /play <link ou nome>", None)).await;
        return;
    }
    if !state.hub.is_online(MUSIC_BOT_ID).await {
        state.hub.send_to(user_id, OutboundEnvelope::error("service_unavailable", "o Tupi Música está iniciando; tente novamente em instantes", None)).await;
        return;
    }
    // Remember who summoned the bot into this voice channel: teardown_call_
    // membership uses it to yank the bot when that DJ leaves, so a finished
    // session can't strand "Tupi Música" in an empty room.
    {
        let mut djs = state.hub.music_djs.write().await;
        match data.command.as_str() {
            "play" => { djs.insert(data.voice_channel_id, user_id); }
            "stop" => { djs.remove(&data.voice_channel_id); }
            _ => {}
        }
    }
    state.hub.send_to(MUSIC_BOT_ID, OutboundEnvelope::new("music.command", serde_json::json!({
        "channel_id": data.channel_id, "voice_channel_id": data.voice_channel_id,
        "command": data.command, "query": data.query, "requested_by": user_id
    }))).await;
    let note = match data.command.as_str() {
        "play" => format!("🎵 **Tupi Música** vai tocar: {}", data.query.as_deref().unwrap_or("")),
        "pause" => "⏸️ **Tupi Música** pausou a reprodução.".to_string(),
        "resume" => "▶️ **Tupi Música** retomou a reprodução.".to_string(),
        "skip" => "⏭️ **Tupi Música** pulou a faixa.".to_string(),
        "stop" => "⏹️ **Tupi Música** encerrou a fila.".to_string(),
        "queue" => "📜 **Tupi Música**: a fila é controlada pelo DJ nesta versão.".to_string(),
        _ => { state.hub.send_to(user_id, OutboundEnvelope::error("validation_error", "comando de música desconhecido", None)).await; return; }
    };
    // This is a deliberately ephemeral bot reply: no fake database user or
    // forged author id, and all connected community members converge at once.
    match db::channel_community(&state.pool, data.channel_id).await {
        Ok(Some(community_id)) => broadcast_to_community(state, community_id, OutboundEnvelope::new("music.announcement", serde_json::json!({ "channel_id": data.channel_id, "content": note }))).await,
        _ => state.hub.send_to(user_id, OutboundEnvelope::error("not_found", "canal de texto não encontrado", None)).await,
    }
}

async fn handle_chat_create(state: &AppState, user_id: Uuid, data: ChatMessageCreate) {
    let Ok(Some(channel)) = db::channel_if_member(&state.pool, data.channel_id, user_id).await else {
        state
            .hub
            .send_to(
                user_id,
                OutboundEnvelope::error("forbidden", "not a member of this channel's community", data.req_id.as_deref()),
            )
            .await;
        return;
    };
    if channel.kind != "text" {
        state.hub.send_to(user_id, OutboundEnvelope::error("validation_error", "messages can only be sent to text channels", data.req_id.as_deref())).await;
        return;
    }
    if data.content.trim().is_empty() || data.content.len() > 4000 {
        state
            .hub
            .send_to(
                user_id,
                OutboundEnvelope::error("validation_error", "message must be 1..=4000 chars", data.req_id.as_deref()),
            )
            .await;
        return;
    }
    if data.attachment_ids.len() > 10 || data.attachment_ids.iter().collect::<HashSet<_>>().len() != data.attachment_ids.len() {
        state.hub.send_to(user_id, OutboundEnvelope::error("validation_error", "attachments must contain at most 10 unique ids", data.req_id.as_deref())).await;
        return;
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(error) => {
            tracing::error!(%error, "failed to start message transaction");
            state.hub.send_to(user_id, OutboundEnvelope::error("internal_error", "failed to send message", data.req_id.as_deref())).await;
            return;
        }
    };
    // CHAT-FR (retry-safe send): when the client supplies a req_id, a retry
    // after a client-side timeout resolves to the original row instead of
    // inserting a duplicate — see migrations/0002_message_idempotency.sql.
    // `xmax = 0` is the standard Postgres tell for "this RETURNING row came
    // from the INSERT, not the ON CONFLICT DO UPDATE" — used below to skip
    // re-running attachment association (idempotent but pointless on a
    // retry) and, more importantly, to avoid re-broadcasting an already-
    // delivered message to every other client: a retry only means *this*
    // client didn't see its own confirmation, not that nobody did.
    #[derive(sqlx::FromRow)]
    struct CreateMessageRow {
        id: Uuid,
        channel_id: Uuid,
        author_id: Uuid,
        content: String,
        created_at: chrono::DateTime<chrono::Utc>,
        edited_at: Option<chrono::DateTime<chrono::Utc>>,
        is_new_insert: bool,
    }
    let row = sqlx::query_as::<_, CreateMessageRow>(
        "INSERT INTO messages (channel_id, author_id, content, client_req_id) VALUES ($1, $2, $3, $4) \
         ON CONFLICT (channel_id, author_id, client_req_id) WHERE client_req_id IS NOT NULL \
         DO UPDATE SET content = messages.content \
         RETURNING id, channel_id, author_id, content, created_at, edited_at, (xmax = 0) AS is_new_insert",
    )
    .bind(data.channel_id)
    .bind(user_id)
    .bind(&data.content)
    .bind(&data.req_id)
    .fetch_one(&mut *tx)
    .await;

    match row {
        Ok(m) if !m.is_new_insert => {
            let _ = tx.rollback().await;
            state.hub.send_to(user_id, OutboundEnvelope::new(
                "chat.message.created",
                ChatMessageCreated {
                    message: MessageDto {
                        id: m.id,
                        channel_id: m.channel_id,
                        author_id: m.author_id,
                        content: m.content,
                        created_at: m.created_at,
                        edited_at: m.edited_at,
                        attachment_ids: data.attachment_ids,
                    },
                    in_reply_to: data.req_id,
                },
            )).await;
        }
        Ok(m) => {
            if !data.attachment_ids.is_empty() {
                let associated = sqlx::query(
                    "UPDATE attachments SET message_id = $1 WHERE id = ANY($2) AND uploader_id = $3 AND message_id IS NULL",
                )
                .bind(m.id)
                .bind(&data.attachment_ids)
                .bind(user_id)
                .execute(&mut *tx)
                .await;
                match associated {
                    Ok(result) if result.rows_affected() == data.attachment_ids.len() as u64 => {}
                    Ok(_) => {
                        let _ = tx.rollback().await;
                        state.hub.send_to(user_id, OutboundEnvelope::error("validation_error", "one or more attachments are unavailable", data.req_id.as_deref())).await;
                        return;
                    }
                    Err(error) => {
                        tracing::error!(%error, "failed to associate message attachments");
                        let _ = tx.rollback().await;
                        state.hub.send_to(user_id, OutboundEnvelope::error("internal_error", "failed to send message", data.req_id.as_deref())).await;
                        return;
                    }
                }
            }
            if let Err(error) = tx.commit().await {
                tracing::error!(%error, "failed to commit message transaction");
                state.hub.send_to(user_id, OutboundEnvelope::error("internal_error", "failed to send message", data.req_id.as_deref())).await;
                return;
            }
            broadcast_to_community(state, channel.community_id, OutboundEnvelope::new(
                    "chat.message.created",
                    ChatMessageCreated {
                        message: MessageDto {
                            id: m.id,
                            channel_id: m.channel_id,
                            author_id: m.author_id,
                            content: m.content,
                            created_at: m.created_at,
                            edited_at: m.edited_at,
                            attachment_ids: data.attachment_ids,
                        },
                        in_reply_to: data.req_id,
                    },
                )).await;
        }
        Err(e) => {
            tracing::error!(error = %e, "failed to persist chat message");
            state
                .hub
                .send_to(
                    user_id,
                    OutboundEnvelope::error("internal_error", "failed to send message", data.req_id.as_deref()),
                )
                .await;
        }
    }
}

async fn handle_chat_edit(state: &AppState, user_id: Uuid, data: ChatMessageEdit) {
    if data.content.trim().is_empty() || data.content.len() > 4000 {
        state
            .hub
            .send_to(
                user_id,
                OutboundEnvelope::error("validation_error", "message must be 1..=4000 chars", data.req_id.as_deref()),
            )
            .await;
        return;
    }
    let updated = sqlx::query_as::<_, db::Message>(
        "UPDATE messages SET content = $1, edited_at = now() \
         WHERE id = $2 AND author_id = $3 AND deleted_at IS NULL RETURNING *",
    )
    .bind(&data.content)
    .bind(data.message_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await;

    match updated {
        Ok(Some(m)) => {
            if let Ok(Some(channel)) = db::channel_if_member(&state.pool, m.channel_id, user_id).await {
                broadcast_to_community(state, channel.community_id, OutboundEnvelope::new(
                    "chat.message.edited",
                    ChatMessageEdited {
                        message_id: m.id,
                        content: m.content,
                        edited_at: m.edited_at,
                        in_reply_to: data.req_id,
                    },
                )).await;
            }
        }
        Ok(None) => {
            state
                .hub
                .send_to(
                    user_id,
                    OutboundEnvelope::error("forbidden", "message not found or not yours", data.req_id.as_deref()),
                )
                .await;
        }
        Err(e) => tracing::error!(error = %e, "failed to edit message"),
    }
}

async fn handle_chat_delete(state: &AppState, user_id: Uuid, data: ChatMessageDelete) {
    let updated = sqlx::query_as::<_, (Uuid, Uuid)>(
        "UPDATE messages SET deleted_at = now() \
         WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL RETURNING id, channel_id",
    )
    .bind(data.message_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await;

    match updated {
        Ok(Some((message_id, channel_id))) => {
            if let Ok(Some(channel)) = db::channel_if_member(&state.pool, channel_id, user_id).await {
                broadcast_to_community(state, channel.community_id, OutboundEnvelope::new(
                    "chat.message.deleted",
                    ChatMessageDeleted { message_id, channel_id, in_reply_to: data.req_id },
                )).await;
            }
        }
        Ok(None) => {
            state
                .hub
                .send_to(
                    user_id,
                    OutboundEnvelope::error("forbidden", "message not found or not yours", data.req_id.as_deref()),
                )
                .await;
        }
        Err(e) => tracing::error!(error = %e, "failed to delete message"),
    };
}

async fn handle_call_join(
    state: &AppState,
    user_id: Uuid,
    data: CallJoin,
    joined_calls: &mut HashSet<Uuid>,
) {
    let is_bot = user_id == MUSIC_BOT_ID;
    let channel = match db::channel_if_member(&state.pool, data.channel_id, user_id).await {
        Ok(Some(channel)) if channel.kind == "voice" => channel,
        Ok(Some(_)) => {
            state.hub.send_to(user_id, OutboundEnvelope::error("validation_error", "calls can only be joined in voice channels", None)).await;
            return;
        }
        _ if is_bot => match db::channel_by_id(&state.pool, data.channel_id).await {
            Ok(Some(channel)) if channel.kind == "voice" => channel,
            _ => { state.hub.send_to(user_id, OutboundEnvelope::error("not_found", "voice channel not found", None)).await; return; }
        },
        _ => {
        state
            .hub
            .send_to(
                user_id,
                OutboundEnvelope::error("forbidden", "not a member of this channel's community", None),
            )
            .await;
        return;
        }
    };

    let call_is_full = !is_bot && {
        let calls = state.hub.calls.read().await;
        !calls.is_participant(data.channel_id, user_id) && calls.is_full(data.channel_id)
    };
    if call_is_full {
        state.hub.send_to(user_id, OutboundEnvelope::error("call_full", "this voice channel already has 10 participants", None)).await;
        return;
    }

    // A connection can belong to exactly one voice call. Move semantics are
    // intentional: the old roster sees a leave before the new one sees join.
    for previous_channel_id in joined_calls.clone() {
        if previous_channel_id != channel.id {
            joined_calls.remove(&previous_channel_id);
            teardown_call_membership(state, previous_channel_id, user_id, "left").await;
        }
    };

    let snapshot = {
        let mut calls = state.hub.calls.write().await;
        calls.join(data.channel_id, user_id, data.muted, data.deafened, is_bot)
    };
    let snapshot = match snapshot {
        Ok(snapshot) => snapshot,
        Err(CallOpError::CallFull) => {
            state.hub.send_to(user_id, OutboundEnvelope::error("call_full", "this voice channel already has 10 participants", None)).await;
            return;
        }
        Err(_) => {
            state.hub.send_to(user_id, OutboundEnvelope::error("internal_error", "failed to join call", None)).await;
            return;
        }
    };
    state
        .hub
        .send_to(
            user_id,
            OutboundEnvelope::new(
                "call.snapshot",
                CallSnapshot {
                    channel_id: data.channel_id,
                    participants: snapshot.participants,
                    streams: snapshot.streams,
                },
            ),
        )
        .await;

    joined_calls.insert(data.channel_id);

    let others: Vec<Uuid> = state
        .hub
        .calls
        .read()
        .await
        .participant_ids(data.channel_id)
        .into_iter()
        .filter(|id| *id != user_id)
        .collect();
    state
        .hub
        .broadcast_to(
            &others,
            OutboundEnvelope::new(
                "call.peer_joined",
                CallPeerJoined {
                    channel_id: data.channel_id,
                    participant: ParticipantDto {
                        user_id,
                        muted: data.muted,
                        deafened: data.deafened,
                        is_bot,
                    },
                },
            ),
        )
        .await;

    broadcast_voice_roster(state, data.channel_id).await;
}

async fn broadcast_to_community(state: &AppState, community_id: Uuid, event: OutboundEnvelope) {
    match db::community_member_ids(&state.pool, community_id).await {
        Ok(user_ids) => state.hub.broadcast_to(&user_ids, event).await,
        Err(error) => tracing::error!(%community_id, %error, "failed to resolve community realtime recipients"),
    };
}

/// Push the current occupants of one voice channel to the whole community so
/// every member's sidebar stays live — even members who have not joined that
/// call. Call after any change to a call's membership, mute/deafen state, or
/// stream set. Sends an empty roster when the call has ended so stale rows clear.
async fn broadcast_voice_roster(state: &AppState, channel_id: Uuid) {
    let community_id = match db::channel_community(&state.pool, channel_id).await {
        Ok(Some(community_id)) => community_id,
        Ok(None) => return,
        Err(error) => {
            tracing::error!(%channel_id, %error, "failed to resolve voice roster community");
            return;
        }
    };
    let (participants, streams) = {
        let calls = state.hub.calls.read().await;
        (calls.roster(channel_id), calls.roster_streams(channel_id))
    };
    broadcast_to_community(
        state,
        community_id,
        OutboundEnvelope::new(
            "voice.roster",
            VoiceRoster { channel_id, participants, streams },
        ),
    )
    .await;
}

/// One-shot roster snapshot for a freshly connected client: every voice
/// channel with an active call that lives in a community the user belongs to.
async fn send_voice_rooms_snapshot(state: &AppState, user_id: Uuid, connection_id: Uuid) {
    let active = state.hub.calls.read().await.active_channel_ids();
    let rooms = if active.is_empty() {
        vec![]
    } else {
        match db::visible_channel_ids(&state.pool, user_id, &active).await {
            Ok(visible) => {
                let calls = state.hub.calls.read().await;
                visible
                    .into_iter()
                    .map(|channel_id| VoiceRoster {
                        channel_id,
                        participants: calls.roster(channel_id),
                        streams: calls.roster_streams(channel_id),
                    })
                    .filter(|roster| !roster.participants.is_empty())
                    .collect()
            }
            Err(error) => {
                tracing::error!(%user_id, %error, "failed to build voice rooms snapshot");
                vec![]
            }
        }
    };
    state
        .hub
        .send_to_connection(
            user_id,
            connection_id,
            OutboundEnvelope::new("voice.rooms", VoiceRoomsSnapshot { rooms }),
        )
        .await;
}

async fn handle_call_state_update(
    state: &AppState,
    user_id: Uuid,
    data: CallStateUpdate,
) {
    let participant = {
        let mut calls = state.hub.calls.write().await;
        calls
            .update_participant_state(data.channel_id, user_id, data.muted, data.deafened)
    };
    let participant = match participant {
        Ok(participant) => participant,
        Err(_) => {
            state.hub.send_to(user_id, OutboundEnvelope::error("forbidden", "join the call before changing participant state", None)).await;
            return;
        }
    };
    let recipients = state.hub.calls.read().await.participant_ids(data.channel_id);
    state.hub.broadcast_to(
        &recipients,
        OutboundEnvelope::new(
            "call.state.update",
            CallStateUpdateEvent {
                channel_id: data.channel_id,
                user_id,
                muted: participant.muted,
                deafened: participant.deafened,
            },
        ),
    ).await;

    broadcast_voice_roster(state, data.channel_id).await;
}

/// A community owner drags another member's sidebar row onto a voice channel.
/// The server only validates the action and tells the target to move — the
/// target's client then sends a normal `call.join`, so channel-membership
/// checks, the previous-call teardown and all RTC setup run through the
/// existing path with nothing special-cased.
async fn handle_voice_move_member(state: &AppState, actor_id: Uuid, data: VoiceMoveMember) {
    let dest = match db::channel_by_id(&state.pool, data.channel_id).await {
        Ok(Some(channel)) if channel.kind == "voice" => channel,
        _ => {
            state.hub.send_to(actor_id, OutboundEnvelope::error("not_found", "voice channel not found", None)).await;
            return;
        }
    };

    // Only the community owner may drag other members around.
    if !matches!(db::is_community_owner(&state.pool, dest.community_id, actor_id).await, Ok(true)) {
        state.hub.send_to(actor_id, OutboundEnvelope::error("forbidden", "only the community owner can move members", None)).await;
        return;
    }

    if data.user_id == actor_id {
        // Moving yourself is just a normal join.
        state.hub.send_to(actor_id, OutboundEnvelope::new(
            "voice.moved", VoiceMoved { channel_id: data.channel_id, moved_by: actor_id },
        )).await;
        return;
    }

    // Target must belong to the destination channel's community — except the
    // music bot, which is a virtual participant with no membership row.
    if data.user_id != MUSIC_BOT_ID
        && !matches!(db::channel_if_member(&state.pool, dest.id, data.user_id).await, Ok(Some(_)))
    {
        state.hub.send_to(actor_id, OutboundEnvelope::error("validation_error", "that member is not in this community", None)).await;
        return;
    }

    // Target must be online and already sitting in some voice call — dragging
    // is for relocating an occupant, not pulling someone into voice cold.
    let in_a_call = {
        let calls = state.hub.calls.read().await;
        calls.calls.values().any(|call| call.participants.contains_key(&data.user_id))
    };
    if !state.hub.is_online(data.user_id).await || !in_a_call {
        state.hub.send_to(actor_id, OutboundEnvelope::error("validation_error", "that member is not in a voice channel", None)).await;
        return;
    }

    state.hub.send_to(data.user_id, OutboundEnvelope::new(
        "voice.moved", VoiceMoved { channel_id: data.channel_id, moved_by: actor_id },
    )).await;
    tracing::info!(%actor_id, target = %data.user_id, channel_id = %data.channel_id, "voice.move_member");
}

/// Kick a member out of a voice channel. Humans: community-owner only. The
/// music bot: any member of that channel's community — and it gets a full
/// reset (stop playback / playlist, leave), not just a removal.
async fn handle_voice_disconnect_member(state: &AppState, actor_id: Uuid, data: VoiceDisconnectMember) {
    let dest = match db::channel_by_id(&state.pool, data.channel_id).await {
        Ok(Some(channel)) if channel.kind == "voice" => channel,
        _ => {
            state.hub.send_to(actor_id, OutboundEnvelope::error("not_found", "voice channel not found", None)).await;
            return;
        }
    };

    let is_bot = data.user_id == MUSIC_BOT_ID;
    let allowed = if is_bot {
        matches!(db::channel_if_member(&state.pool, dest.id, actor_id).await, Ok(Some(_)))
    } else {
        matches!(db::is_community_owner(&state.pool, dest.community_id, actor_id).await, Ok(true))
    };
    if !allowed {
        let msg = if is_bot { "join this community first" } else { "only the community owner can disconnect members" };
        state.hub.send_to(actor_id, OutboundEnvelope::error("forbidden", msg, None)).await;
        return;
    }

    if !state.hub.calls.read().await.is_participant(data.channel_id, data.user_id) {
        state.hub.send_to(actor_id, OutboundEnvelope::error("validation_error", "that member is not in this voice channel", None)).await;
        return;
    }

    if is_bot {
        // Full reset — the bot's `music.command stop` handler stops yt-dlp /
        // ffmpeg / any playlist and leaves the channel.
        state.hub.music_djs.write().await.remove(&data.channel_id);
        state.hub.send_to(MUSIC_BOT_ID, OutboundEnvelope::new(
            "music.command", serde_json::json!({ "command": "stop", "voice_channel_id": data.channel_id }),
        )).await;
    } else {
        // The kicked client leaves the call on this event.
        state.hub.send_to(data.user_id, OutboundEnvelope::new(
            "voice.disconnected", VoiceDisconnected { channel_id: data.channel_id, by: actor_id },
        )).await;
    }

    // Remove from the registry now so the roster clears immediately even if
    // the target's client is slow to react.
    teardown_call_membership(state, data.channel_id, data.user_id, "disconnected").await;
    tracing::info!(%actor_id, target = %data.user_id, channel_id = %data.channel_id, bot = is_bot, "voice.disconnect_member");
}

async fn relay_rtc(
    state: &AppState,
    from: Uuid,
    channel_id: Uuid,
    to: Uuid,
    op: &str,
    payload: impl serde::Serialize,
) {
    let ok = {
        let calls = state.hub.calls.read().await;
        // Either end may be a spectator (subscribed to a stream in this
        // channel) rather than a full call participant — that pairing carries
        // the owner→viewer screen-share offer/answer/ice.
        let endpoint_allowed = |uid| {
            calls.is_participant(channel_id, uid) || calls.is_stream_viewer(channel_id, uid)
        };
        endpoint_allowed(from) && endpoint_allowed(to)
    };
    if !ok {
        state
            .hub
            .send_to(
                from,
                OutboundEnvelope::error(
                    "forbidden",
                    "target is not a participant of this call",
                    None,
                ),
            )
            .await;
        return;
    }
    if !state.hub.is_online(to).await {
        state
            .hub
            .send_to(from, OutboundEnvelope::error("peer_offline", "target is not connected", None))
            .await;
        return;
    }
    let mut payload = match serde_json::to_value(payload) {
        Ok(serde_json::Value::Object(payload)) => payload,
        Ok(_) | Err(_) => {
            tracing::error!(%from, %to, %channel_id, "rtc relay payload was not an object");
            state.hub.send_to(from, OutboundEnvelope::error("internal_error", "failed to relay RTC signal", None)).await;
            return;
        }
    };
    if serde_json::to_vec(&payload).map_or(true, |encoded| encoded.len() > 64 * 1024) {
        state.hub.send_to(from, OutboundEnvelope::error("validation_error", "RTC signal exceeds 64 KiB", None)).await;
        return;
    }
    // Inbound RTC messages name only their target. The recipient needs an
    // authenticated sender identity to route the signal to its PeerController;
    // it is injected server-side rather than trusted from the client payload.
    payload.insert("from".to_string(), serde_json::json!(from));
    state
        .hub
        .send_to(to, OutboundEnvelope::new(op, serde_json::Value::Object(payload)))
        .await;
}

async fn handle_stream_publish(state: &AppState, user_id: Uuid, data: StreamPublish) {
    if data.kind != "screen" && data.kind != "music" && data.kind != "camera" {
        state
            .hub
            .send_to(user_id, OutboundEnvelope::error("validation_error", "only screen, camera and music streams are available", None))
            .await;
        return;
    }
    let is_music = data.kind == "music";
    let result = {
        let mut calls = state.hub.calls.write().await;
        calls.publish(
            data.channel_id,
            user_id,
            data.stream_id,
            data.kind.clone(),
            data.label.clone(),
            data.has_audio,
            data.msid.clone(),
        )
    };
    if let Err(error) = result {
        let (code, message) = match error {
            CallOpError::NotInCall => ("forbidden", "join the call before publishing"),
            CallOpError::StreamAlreadyPublished => ("conflict", "only one stream of each kind per publisher is allowed"),
            _ => ("validation_error", "unable to publish stream"),
        };
        state.hub.send_to(user_id, OutboundEnvelope::error(code, message, None)).await;
        return;
    }
    let participants = state.hub.calls.read().await.participant_ids(data.channel_id);
    state
        .hub
        .broadcast_to(
            &participants,
            OutboundEnvelope::new(
                "stream.published",
                StreamPublished {
                    channel_id: data.channel_id,
                    stream_id: data.stream_id,
                    owner: user_id,
                    kind: data.kind.clone(),
                    label: data.label.clone(),
                    has_audio: data.has_audio,
                    msid: data.msid.clone(),
                },
            ),
        )
        .await;

    // Music is an always-on audio broadcast, unlike a screen preview. Every
    // current peer is subscribed immediately; the local DJ opens the direct
    // WebRTC audio transceiver after receiving this request.
    if is_music {
        for subscriber in participants.into_iter().filter(|id| *id != user_id) {
            state.hub.send_to(subscriber, OutboundEnvelope::new("music.available", serde_json::json!({
                "channel_id": data.channel_id, "stream_id": data.stream_id, "owner": user_id, "label": data.label
            }))).await;
        }
    }

    broadcast_voice_roster(state, data.channel_id).await;
}

async fn handle_stream_unpublish(state: &AppState, user_id: Uuid, data: StreamUnpublish) {
    let result = {
        let mut calls = state.hub.calls.write().await;
        calls.unpublish(data.channel_id, user_id, data.stream_id)
    };
    match result {
        Ok(_viewers) => {
            let participants = state.hub.calls.read().await.participant_ids(data.channel_id);
            state
                .hub
                .broadcast_to(
                    &participants,
                    OutboundEnvelope::new(
                        "stream.unpublished",
                        StreamUnpublished {
                            channel_id: data.channel_id,
                            stream_id: data.stream_id,
                        },
                    ),
                )
                .await;
            broadcast_voice_roster(state, data.channel_id).await;
        }
        Err(CallOpError::NotStreamOwner) => {
            state
                .hub
                .send_to(user_id, OutboundEnvelope::error("forbidden", "you do not own this stream", None))
                .await;
        }
        Err(_) => {
            state
                .hub
                .send_to(user_id, OutboundEnvelope::error("not_found", "stream not found", None))
                .await;
        }
    }
}

async fn handle_stream_subscribe(state: &AppState, user_id: Uuid, data: StreamSubscribe) {
    // A subscriber who is not already in the call may still spectate a stream
    // (hover preview from the sidebar) as long as they belong to the channel's
    // community. Participants are trivially members, so one check covers both.
    let is_participant = state
        .hub
        .calls
        .read()
        .await
        .is_participant(data.channel_id, user_id);
    if !is_participant {
        match db::channel_if_member(&state.pool, data.channel_id, user_id).await {
            Ok(Some(_)) => {}
            _ => {
                state
                    .hub
                    .send_to(user_id, OutboundEnvelope::error("forbidden", "not a member of this channel's community", None))
                    .await;
                return;
            }
        }
    }
    let result = {
        let mut calls = state.hub.calls.write().await;
        calls.subscribe(data.channel_id, user_id, data.stream_id)
    };
    match result {
        Ok(owner) => {
            state
                .hub
                .send_to(
                    owner,
                    OutboundEnvelope::new(
                        "stream.subscription_requested",
                        StreamSubscriptionRequested {
                            channel_id: data.channel_id,
                            stream_id: data.stream_id,
                            subscriber: user_id,
                        },
                    ),
                )
                .await;
        }
        Err(_) => {
            state
                .hub
                .send_to(user_id, OutboundEnvelope::error("not_found", "stream not found or you're not in this call", None))
                .await;
        }
    }
}

async fn handle_stream_unsubscribe(state: &AppState, user_id: Uuid, data: StreamUnsubscribe) {
    let result = {
        let mut calls = state.hub.calls.write().await;
        calls.unsubscribe(data.channel_id, user_id, data.stream_id)
    };
    if let Ok(owner) = result {
        state
            .hub
            .send_to(
                owner,
                OutboundEnvelope::new(
                    "stream.unsubscribed",
                    StreamUnsubscribed {
                        channel_id: data.channel_id,
                        stream_id: data.stream_id,
                        subscriber: user_id,
                    },
                ),
            )
            .await;
    }
}
