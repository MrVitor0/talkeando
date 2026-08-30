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
pub struct WebhookEvent { pub event: String, pub room: Option<Room>, pub participant: Option<Participant>, pub track: Option<Track> }
#[derive(Debug, Deserialize)]
pub struct Room { pub name: String }
#[derive(Debug, Deserialize)]
pub struct Participant { pub identity: String }
#[derive(Debug, Deserialize)]
pub struct Track { pub source: String, #[serde(default)] pub sid: Option<String> }

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

pub async fn remove_participant(cfg: &Config, room: &str, identity: &str) -> Result<()> {
    let (key, _) = credentials(cfg)?;
    let base = cfg.livekit_url.as_deref().ok_or_else(|| anyhow!("LiveKit URL is not configured"))?.replace("wss://", "https://").replace("ws://", "http://");
    let token = access_token(cfg, key, "server", room, Mode::Participant, serde_json::json!({}))?;
    let response = reqwest::Client::new().post(format!("{base}/twirp/livekit.RoomService/RemoveParticipant")).bearer_auth(token).json(&serde_json::json!({"room": room, "identity": identity})).send().await?;
    if !response.status().is_success() { return Err(anyhow!("LiveKit RemoveParticipant failed: {}", response.status())); }
    Ok(())
}
