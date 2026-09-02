use axum::{extract::{State, Json}, http::{header, HeaderMap}, Json as AxumJson};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    auth::authenticate_token,
    db,
    error::{AppError, AppResult},
    livekit::{self, Mode},
    state::AppState,
    ws::{handler::broadcast_voice_roster, voice_metrics::VoiceMetrics},
};

const MUSIC_BOT_ID: Uuid = Uuid::from_u128(1);

#[derive(Deserialize)] pub struct TokenRequest { pub channel_id: Uuid, #[serde(default)] pub mode: Mode }
#[derive(Serialize)] pub struct TokenResponse { pub url: String, pub room: Uuid, pub token: String }

async fn identity_from_headers(state: &AppState, headers: &HeaderMap) -> AppResult<(Uuid, String, bool)> {
    let token = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).ok_or(AppError::Unauthorized)?;
    if token == state.config.music_bot_token { return Ok((MUSIC_BOT_ID, "Music bot".into(), true)); }
    let (user, _) = authenticate_token(&state.pool, token).await?;
    Ok((user.id, user.display_name, false))
}

/// Logs and counts a token refusal (SPEC-002 §4.3). The `AppError` is returned
/// unchanged — this spec only instruments, it never alters behaviour.
fn refuse_token(state: &AppState, channel_id: Uuid, user_id: Uuid, reason: &'static str, error: AppError) -> AppError {
    VoiceMetrics::bump(&state.voice_metrics.tokens_refused);
    tracing::info!(event = "voice.token.refused", %channel_id, %user_id, reason);
    error
}

pub async fn token(State(state): State<AppState>, headers: HeaderMap, Json(request): Json<TokenRequest>) -> AppResult<AxumJson<TokenResponse>> {
    let (identity, name, is_bot) = identity_from_headers(&state, &headers).await?;
    let channel = db::channel_by_id(&state.pool, request.channel_id)
        .await?
        .ok_or_else(|| refuse_token(&state, request.channel_id, identity, "not_found", AppError::NotFound))?;
    if channel.kind != "voice" {
        return Err(refuse_token(&state, request.channel_id, identity, "not_voice", AppError::Forbidden));
    }
    if !is_bot && db::channel_if_member(&state.pool, request.channel_id, identity).await?.is_none() {
        return Err(refuse_token(&state, request.channel_id, identity, "not_member", AppError::Forbidden));
    }
    let url = state
        .config
        .livekit_url
        .clone()
        .ok_or_else(|| refuse_token(&state, request.channel_id, identity, "livekit_unconfigured", AppError::ServiceUnavailable("LiveKit is not configured".into())))?;
    let token = livekit::access_token(&state.config, &identity.to_string(), &name, &request.channel_id.to_string(), request.mode, serde_json::json!({"is_bot": is_bot}))
        .map_err(|_| refuse_token(&state, request.channel_id, identity, "token_generation_failed", AppError::ServiceUnavailable("LiveKit is not configured".into())))?;
    // Best-effort projection so the sidebar fills in the moment a token is
    // minted. The authoritative lifecycle is the `voice.presence.*` WS pair
    // (socket-lifetime-bound: it evicts on channel switch, explicit leave, and
    // disconnect); this add is just reconciled by it. The bot has no WS
    // presence flow, so for the bot this is the only "joined" signal — it is
    // removed again by the "only the bot is left" check / the webhook.
    // A token only authorizes a possible room connection. Recording presence
    // here made rapid clicks on two channels create two roster entries; the
    // authenticated WebSocket announces presence only after it connects.
    VoiceMetrics::bump(&state.voice_metrics.tokens_issued);
    tracing::info!(
        event = "voice.token.issued",
        channel_id = %request.channel_id,
        user_id = %identity,
        mode = ?request.mode,
        is_bot,
    );
    Ok(AxumJson(TokenResponse { url, room: request.channel_id, token }))
}

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

    match event.event.as_str() {
        "participant_joined" => if let Some(user) = participant {
            state.hub.calls.write().await.apply_participant(room, user, true);
            VoiceMetrics::bump(&state.voice_metrics.participants_added_by_webhook);
            tracing::info!(event = "voice.registry.participant_added", channel_id = %room, user_id = %user, source = "webhook", outcome = "applied");
            broadcast_voice_roster(&state, room).await;
        },
        "participant_left" => if let Some(user) = participant {
            state.hub.calls.write().await.apply_participant(room, user, false);
            VoiceMetrics::bump(&state.voice_metrics.participants_removed_by_webhook);
            tracing::info!(event = "voice.registry.participant_removed", channel_id = %room, user_id = %user, source = "webhook", outcome = "applied");
            broadcast_voice_roster(&state, room).await;
        },
        "track_published" => if let (Some(user), Some(track)) = (participant, event.track) {
            state.hub.calls.write().await.apply_track(room, user, &track.source, true, track.sid.clone());
            tracing::info!(event = "voice.registry.track_added", channel_id = %room, user_id = %user, track_sid = track.sid.as_deref().unwrap_or("-"), track_source = %track.source, source = "webhook", outcome = "applied");
            broadcast_voice_roster(&state, room).await;
        },
        "track_unpublished" => if let (Some(user), Some(track)) = (participant, event.track) {
            state.hub.calls.write().await.apply_track(room, user, &track.source, false, track.sid.clone());
            tracing::info!(event = "voice.registry.track_removed", channel_id = %room, user_id = %user, track_sid = track.sid.as_deref().unwrap_or("-"), track_source = %track.source, source = "webhook", outcome = "applied");
            broadcast_voice_roster(&state, room).await;
        },
        // A media room can finish after a transient participant disconnects or
        // after a user changes channels. Music playback is controlled only by
        // an explicit /stop (or the bot's idle timeout), never by the
        // lifecycle of an unrelated LiveKit room.
        "room_finished" => {
            state.hub.calls.write().await.clear_channel(room);
            tracing::info!(event = "voice.webhook.applied", livekit_event = "room_finished", channel_id = %room, source = "webhook", outcome = "applied");
            broadcast_voice_roster(&state, room).await;
        },
        other => {
            tracing::info!(event = "voice.webhook.ignored", outcome = "unhandled_event", livekit_event = other, channel_id = %room);
        }
    }
    Ok(())
}
