use axum::{extract::State, Json};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use hmac::{Hmac, Mac};
use serde::Serialize;
use sha1::Sha1;

use crate::{auth::AuthUser, error::AppResult, state::AppState};

#[derive(Serialize)]
pub struct TurnCredentials {
    pub username: String,
    pub credential: String,
    pub ttl_seconds: i64,
    pub uris: Vec<String>,
    pub realm: String,
}

/// SEC-NFR: never ship long-lived static TURN credentials to clients.
/// Implements coturn's `use-auth-secret` time-limited REST credential
/// scheme: username = "<unix_expiry>:<user_id>", password =
/// base64(HMAC-SHA1(shared_secret, username)). coturn is configured with
/// the same `TURN_SHARED_SECRET` (see infra/coturn/turnserver.conf).
pub async fn credentials(
    State(state): State<AppState>,
    auth: AuthUser,
) -> AppResult<Json<TurnCredentials>> {
    let expiry = chrono::Utc::now().timestamp() + state.config.turn_credential_ttl_seconds;
    let username = format!("{expiry}:{}", auth.user.id);

    let mut mac = Hmac::<Sha1>::new_from_slice(state.config.turn_shared_secret.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(username.as_bytes());
    let credential = STANDARD.encode(mac.finalize().into_bytes());

    Ok(Json(TurnCredentials {
        username,
        credential,
        ttl_seconds: state.config.turn_credential_ttl_seconds,
        uris: state.config.turn_uris.clone(),
        realm: state.config.turn_realm.clone(),
    }))
}
