use axum::{extract::{State, Json}, http::{header, HeaderMap}, Json as AxumJson};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{auth::{authenticate_token, AuthUser}, db, error::{AppError, AppResult}, livekit::{self, Mode}, state::AppState, ws::{handler::broadcast_voice_roster, protocol::OutboundEnvelope}};

const MUSIC_BOT_ID: Uuid = Uuid::from_u128(1);

#[derive(Deserialize)] pub struct TokenRequest { pub channel_id: Uuid, #[serde(default)] pub mode: Mode }
#[derive(Serialize)] pub struct TokenResponse { pub url: String, pub room: Uuid, pub token: String }

async fn identity_from_headers(state: &AppState, headers: &HeaderMap) -> AppResult<(Uuid, String, bool)> {
    let token = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).ok_or(AppError::Unauthorized)?;
    if token == state.config.music_bot_token { return Ok((MUSIC_BOT_ID, "Music bot".into(), true)); }
    let (user, _) = authenticate_token(&state.pool, token).await?;
    Ok((user.id, user.display_name, false))
}

pub async fn token(State(state): State<AppState>, headers: HeaderMap, Json(request): Json<TokenRequest>) -> AppResult<AxumJson<TokenResponse>> {
    let (identity, name, is_bot) = identity_from_headers(&state, &headers).await?;
    let channel = db::channel_by_id(&state.pool, request.channel_id).await?.ok_or(AppError::NotFound)?;
    if channel.kind != "voice" { return Err(AppError::Forbidden); }
    if !is_bot && db::channel_if_member(&state.pool, request.channel_id, identity).await?.is_none() { return Err(AppError::Forbidden); }
    let url = state.config.livekit_url.clone().ok_or_else(|| AppError::ServiceUnavailable("LiveKit is not configured".into()))?;
    let token = livekit::access_token(&state.config, &identity.to_string(), &name, &request.channel_id.to_string(), request.mode, serde_json::json!({"is_bot": is_bot}))
        .map_err(|_| AppError::ServiceUnavailable("LiveKit is not configured".into()))?;
    Ok(AxumJson(TokenResponse { url, room: request.channel_id, token }))
}

pub async fn webhook(State(state): State<AppState>, headers: HeaderMap, body: String) -> AppResult<()> {
    let authorization = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).ok_or(AppError::Unauthorized)?;
    let event = livekit::verify_webhook(&state.config, authorization).map_err(|_| AppError::Unauthorized)?;
    let Some(room) = event.room.and_then(|room| Uuid::parse_str(&room.name).ok()) else { return Ok(()); };
    let participant = event.participant.and_then(|p| Uuid::parse_str(&p.identity).ok());
    match event.event.as_str() {
        "participant_joined" => if let Some(user) = participant { state.hub.calls.write().await.apply_participant(room, user, true); broadcast_voice_roster(&state, room).await; },
        "participant_left" => if let Some(user) = participant { state.hub.calls.write().await.apply_participant(room, user, false); let only_bot = { let calls = state.hub.calls.read().await; calls.participant_ids(room) == vec![MUSIC_BOT_ID] }; if only_bot { state.hub.send_to(MUSIC_BOT_ID, OutboundEnvelope::new("music.command", serde_json::json!({"command":"stop","voice_channel_id":room,"reason":"empty"}))).await; let _ = livekit::remove_participant(&state.config, &room.to_string(), &MUSIC_BOT_ID.to_string()).await; } broadcast_voice_roster(&state, room).await; },
        "track_published" => if let (Some(user), Some(track)) = (participant, event.track) { state.hub.calls.write().await.apply_track(room, user, &track.source, true); broadcast_voice_roster(&state, room).await; },
        "track_unpublished" => if let (Some(user), Some(track)) = (participant, event.track) { state.hub.calls.write().await.apply_track(room, user, &track.source, false); broadcast_voice_roster(&state, room).await; },
        "room_finished" => { state.hub.calls.write().await.clear_channel(room); state.hub.send_to(MUSIC_BOT_ID, OutboundEnvelope::new("music.command", serde_json::json!({"command":"stop","voice_channel_id":room,"reason":"room_finished"}))).await; broadcast_voice_roster(&state, room).await; },
        _ => {}
    }
    let _ = body; // axum extracts the raw body before signature processing.
    Ok(())
}
