use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    async_trait,
    extract::{FromRef, FromRequestParts},
    http::request::Parts,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use rand::RngCore;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{db::User, error::AppError, state::AppState};

pub fn hash_password(password: &str) -> Result<String, AppError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| AppError::Internal(anyhow::anyhow!("password hash failed: {e}")))
}

/// Canonical v1 username form (AUTH-FR-003). Normalizing at the boundary
/// makes login case-insensitive without weakening the stored uniqueness rule.
pub fn normalize_username(username: &str) -> Result<String, AppError> {
    let normalized = username.trim().to_ascii_lowercase();
    let valid = (3..=24).contains(&normalized.len())
        && normalized
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_');
    if !valid {
        return Err(AppError::Validation(
            "username must be 3..=24 lowercase letters, numbers, or underscores".into(),
        ));
    }
    Ok(normalized)
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

/// Raw session token given to the client once. Only its SHA-256 hash is
/// ever persisted (server/migrations/0001_init.sql: sessions.token_hash).
pub fn generate_session_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

/// Shared by the REST `AuthUser` extractor and the WebSocket `auth.hello`
/// handshake (AUTH-FR-006, WS-FR-001) so both paths enforce identical
/// expiry/revocation rules from one place.
pub async fn authenticate_token(pool: &PgPool, token: &str) -> Result<(User, Uuid), AppError> {
    let token_hash = hash_token(token);

    let session = sqlx::query_as::<_, crate::db::Session>(
        "SELECT * FROM sessions WHERE token_hash = $1",
    )
    .bind(&token_hash)
    .fetch_optional(pool)
    .await?
    .ok_or(AppError::Unauthorized)?;

    if session.revoked_at.is_some() || session.expires_at < Utc::now() {
        return Err(AppError::Unauthorized);
    }

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(session.user_id)
        .fetch_optional(pool)
        .await?
        .ok_or(AppError::Unauthorized)?;

    Ok((user, session.id))
}

pub async fn touch_session(pool: &PgPool, session_id: Uuid, ttl_days: i64) {
    let new_expiry = Utc::now() + chrono::Duration::days(ttl_days);
    let _ = sqlx::query("UPDATE sessions SET expires_at = $1 WHERE id = $2")
        .bind(new_expiry)
        .bind(session_id)
        .execute(pool)
        .await;
}

/// Authenticated user extracted from the `Authorization: Bearer <token>`
/// header on REST requests (AUTH-FR-006).
pub struct AuthUser {
    pub user: User,
    pub session_id: Uuid,
}

#[async_trait]
impl<S> FromRequestParts<S> for AuthUser
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let app_state = AppState::from_ref(state);
        let header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::Unauthorized)?;
        let token = header
            .strip_prefix("Bearer ")
            .ok_or(AppError::Unauthorized)?;

        let (user, session_id) = authenticate_token(&app_state.pool, token).await?;
        touch_session(&app_state.pool, session_id, app_state.config.session_ttl_days).await;
        Ok(AuthUser { user, session_id })
    }
}
