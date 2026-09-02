//! Small LiveKit control-plane client. Media never traverses this process.
use anyhow::{anyhow, Result};
use chrono::{Duration, Utc};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

use crate::config::Config;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Mode { Participant, Spectator }
impl Default for Mode { fn default() -> Self { Self::Participant } }

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoGrant { pub room: String, pub room_join: bool, pub can_publish: bool, pub can_subscribe: bool, pub can_publish_data: bool, pub hidden: bool }
#[derive(Debug, Serialize, Deserialize)]
pub struct Claims { pub iss: String, pub sub: String, pub name: String, pub exp: i64, pub nbf: i64, pub metadata: String, pub video: VideoGrant }

fn credentials(cfg: &Config) -> Result<(&str, &str)> {
    Ok((cfg.livekit_api_key.as_deref().ok_or_else(|| anyhow!("LiveKit API key is not configured"))?, cfg.livekit_api_secret.as_deref().ok_or_else(|| anyhow!("LiveKit API secret is not configured"))?))
}

pub fn access_token(cfg: &Config, identity: &str, name: &str, room: &str, mode: Mode, metadata: serde_json::Value) -> Result<String> {
    let (key, secret) = credentials(cfg)?;
    let now = Utc::now();
    let spectator = mode == Mode::Spectator;
    let claims = Claims { iss: key.to_owned(), sub: identity.to_owned(), name: name.to_owned(), nbf: now.timestamp(), exp: (now + Duration::seconds(cfg.livekit_token_ttl_seconds)).timestamp(), metadata: metadata.to_string(), video: VideoGrant { room: room.to_owned(), room_join: true, can_publish: !spectator, can_subscribe: true, can_publish_data: false, hidden: spectator } };
    let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims)?);
    let signing_input = format!("{header}.{payload}");
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())?;
    mac.update(signing_input.as_bytes());
    Ok(format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())))
}

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

#[derive(Deserialize)]
struct WebhookClaims { iss: String, sha256: String }

/// LiveKit signs the SHA-256 of the raw webhook body in the JWT sent through
/// Authorization. The event itself is JSON in the body, not JWT claims.
pub fn verify_webhook(cfg: &Config, auth_header: &str, body: &str) -> Result<WebhookEvent> {
    let (key, secret) = credentials(cfg)?;
    let token = auth_header.strip_prefix("Bearer ").unwrap_or(auth_header);
    let mut parts = token.split('.');
    let header = parts.next().ok_or_else(|| anyhow!("malformed webhook token"))?;
    let payload = parts.next().ok_or_else(|| anyhow!("malformed webhook token"))?;
    let signature = parts.next().ok_or_else(|| anyhow!("malformed webhook token"))?;
    if parts.next().is_some() { return Err(anyhow!("malformed webhook token")); }
    let supplied = URL_SAFE_NO_PAD.decode(signature)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())?;
    mac.update(format!("{header}.{payload}").as_bytes()); mac.verify_slice(&supplied)?;
    let claims: WebhookClaims = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload)?)?;
    if claims.iss != key { return Err(anyhow!("unexpected webhook API key")); }
    let actual_hash = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(body.as_bytes()));
    if claims.sha256 != actual_hash { return Err(anyhow!("webhook body hash mismatch")); }
    Ok(serde_json::from_str(body)?)
}

fn http_base(cfg: &Config) -> Result<String> {
    Ok(cfg
        .livekit_url
        .as_deref()
        .ok_or_else(|| anyhow!("LiveKit URL is not configured"))?
        .replace("wss://", "https://")
        .replace("ws://", "http://"))
}

/// Signs a short-lived RoomService admin JWT. The `video` grant differs per
/// call — `roomList` for ListRooms, `roomAdmin` + `room` for the room-scoped
/// endpoints (ListParticipants, RemoveParticipant).
fn admin_token(cfg: &Config, video_grant: serde_json::Value) -> Result<String> {
    let (key, secret) = credentials(cfg)?;
    let now = Utc::now();
    let claims = serde_json::json!({
        "iss": key,
        "sub": "tupi-server",
        "nbf": now.timestamp(),
        "exp": (now + Duration::seconds(60)).timestamp(),
        "video": video_grant,
    });
    let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims)?);
    let signing_input = format!("{header}.{payload}");
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())?;
    mac.update(signing_input.as_bytes());
    Ok(format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())))
}

pub async fn remove_participant(cfg: &Config, room: &str, identity: &str) -> Result<()> {
    let base = http_base(cfg)?;
    let token = admin_token(cfg, serde_json::json!({ "roomAdmin": true, "room": room }))?;
    let response = reqwest::Client::new().post(format!("{base}/twirp/livekit.RoomService/RemoveParticipant")).bearer_auth(token).json(&serde_json::json!({"room": room, "identity": identity})).send().await?;
    if !response.status().is_success() { return Err(anyhow!("LiveKit RemoveParticipant failed: {}", response.status())); }
    Ok(())
}

/// One participant as LiveKit currently sees them, carrying their tracks as-is
/// (track_sid + source + muted) rather than flattening into camera/screen sids
/// — the v2 `VoiceRegistry` keys tracks by their real SID.
#[derive(Debug, Clone)]
pub struct RoomParticipant {
    pub identity: String,
    pub sid: String,
    /// `(track_sid, lowercase LiveKit source, muted)`
    pub tracks: Vec<(String, String, bool)>,
}

#[derive(Debug, Deserialize)]
struct ListRoomsResponse {
    #[serde(default)]
    rooms: Vec<RoomInfo>,
}
#[derive(Debug, Deserialize)]
struct RoomInfo {
    name: String,
}
#[derive(Debug, Deserialize)]
struct ListParticipantsResponse {
    #[serde(default)]
    participants: Vec<ParticipantInfo>,
}
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

/// Shared filter+shape rule for `room_snapshot` and `room_participants`.
/// Drops disconnected and hidden (spectator, INV-B3) participants, and any
/// without a sid (cannot be addressed).
fn map_participants(participants: Vec<ParticipantInfo>) -> Vec<RoomParticipant> {
    participants
        .into_iter()
        .filter(|p| p.state.as_deref() != Some("DISCONNECTED"))
        .filter(|p| !p.permission.map(|perm| perm.hidden).unwrap_or(false))
        .filter_map(|p| {
            let sid = p.sid?;
            Some(RoomParticipant {
                identity: p.identity,
                sid,
                tracks: p
                    .tracks
                    .into_iter()
                    .map(|t| (t.sid, t.source.unwrap_or_default().to_ascii_lowercase(), t.muted))
                    .collect(),
            })
        })
        .collect()
}

/// Participants of ONE room. Used by the directed reconcile (leave, kick,
/// move, room_finished), which does not need to sweep the whole server. A room
/// that does not exist is treated as empty, never as an error (§4.1).
pub async fn room_participants(cfg: &Config, room: &str) -> Result<Vec<RoomParticipant>> {
    let base = http_base(cfg)?;
    let token = admin_token(cfg, serde_json::json!({ "roomAdmin": true, "room": room }))?;
    let response = reqwest::Client::new()
        .post(format!("{base}/twirp/livekit.RoomService/ListParticipants"))
        .bearer_auth(token)
        .json(&serde_json::json!({ "room": room }))
        .send()
        .await?;
    if !response.status().is_success() {
        return Ok(vec![]);
    }
    let parsed: ListParticipantsResponse = response.json().await?;
    Ok(map_participants(parsed.participants))
}

/// Authoritative snapshot of every live room and its non-disconnected
/// participants. Used to rebuild the ephemeral call registry after a server
/// restart or a dropped webhook — LiveKit never replays `participant_joined`
/// for members already in a room, so this is the only way that state comes
/// back without waiting on each client to re-announce itself.
pub async fn room_snapshot(cfg: &Config) -> Result<Vec<(String, Vec<RoomParticipant>)>> {
    let base = http_base(cfg)?;
    let client = reqwest::Client::new();

    let rooms_token = admin_token(cfg, serde_json::json!({ "roomList": true }))?;
    let rooms: ListRoomsResponse = client
        .post(format!("{base}/twirp/livekit.RoomService/ListRooms"))
        .bearer_auth(rooms_token)
        .json(&serde_json::json!({}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let mut out = Vec::with_capacity(rooms.rooms.len());
    for room in rooms.rooms {
        let token = admin_token(cfg, serde_json::json!({ "roomAdmin": true, "room": room.name }))?;
        let response: ListParticipantsResponse = client
            .post(format!("{base}/twirp/livekit.RoomService/ListParticipants"))
            .bearer_auth(token)
            .json(&serde_json::json!({ "room": room.name }))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        out.push((room.name, map_participants(response.participants)));
    }
    Ok(out)
}
