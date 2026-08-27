use std::net::SocketAddr;

use axum::{extract::{ConnectInfo, State}, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    auth::{generate_session_token, hash_password, hash_token, normalize_username, verify_password, AuthUser},
    db::{Invite, PublicUser, User},
    error::{AppError, AppResult},
    state::AppState,
};

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub invite_code: String,
    pub username: String,
    pub password: String,
    pub display_name: String,
}

#[derive(Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user: PublicUser,
    pub session_expires_at: chrono::DateTime<chrono::Utc>,
}

/// AUTH-FR-001: registration is invite-code gated, matching the "private
/// community of ~10 people" model — there is no open self-signup endpoint.
pub async fn register(
    State(state): State<AppState>,
    Json(req): Json<RegisterRequest>,
) -> AppResult<Json<AuthResponse>> {
    let username = normalize_username(&req.username)?;
    if req.password.len() < 8 {
        return Err(AppError::Validation("password must be at least 8 chars".into()));
    }
    if req.display_name.trim().is_empty() {
        return Err(AppError::Validation("display_name is required".into()));
    }

    let mut tx = state.pool.begin().await?;

    let invite = sqlx::query_as::<_, Invite>(
        "SELECT * FROM invites WHERE code = $1 \
         AND (expires_at IS NULL OR expires_at > now()) \
         AND (max_uses IS NULL OR uses < max_uses) \
         FOR UPDATE",
    )
    .bind(&req.invite_code)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::Validation("invite code invalid, expired, or exhausted".into()))?;

    let password_hash = hash_password(&req.password)?;

    let user = sqlx::query_as::<_, User>(
        "INSERT INTO users (username, display_name, password_hash) VALUES ($1, $2, $3) RETURNING *",
    )
    .bind(&username)
    .bind(&req.display_name)
    .bind(&password_hash)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(ref db_err)
            if db_err.kind() == sqlx::error::ErrorKind::UniqueViolation =>
        {
            AppError::Conflict("username already taken".into())
        }
        other => AppError::Database(other),
    })?;

    sqlx::query("INSERT INTO community_members (community_id, user_id, role) VALUES ($1, $2, 'member')")
        .bind(invite.community_id)
        .bind(user.id)
        .execute(&mut *tx)
        .await?;

    sqlx::query("UPDATE invites SET uses = uses + 1 WHERE id = $1")
        .bind(invite.id)
        .execute(&mut *tx)
        .await?;

    let token = generate_session_token();
    let expires_at = chrono::Utc::now() + chrono::Duration::days(state.config.session_ttl_days);
    sqlx::query("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)")
        .bind(user.id)
        .bind(hash_token(&token))
        .bind(expires_at)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    tracing::info!(user_id = %user.id, "user registered");
    Ok(Json(AuthResponse {
        token,
        user: user.into(),
        session_expires_at: expires_at,
    }))
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

/// AUTH-NFR-002: fixed-window rate limit + constant-time-verifying, generic
/// error message regardless of which check failed (username vs password).
pub async fn login(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<LoginRequest>,
) -> AppResult<Json<AuthResponse>> {
    let username = req.username.trim().to_ascii_lowercase();
    let rate_limit_key = format!("{}:{username}", peer.ip());
    if !state.check_login_rate_limit(&rate_limit_key).await {
        return Err(AppError::RateLimited);
    }

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE username = $1")
        .bind(&username)
        .fetch_optional(&state.pool)
        .await?;

    let user = match user {
        Some(u) if verify_password(&req.password, &u.password_hash) => u,
        _ => return Err(AppError::Unauthorized),
    };

    let token = generate_session_token();
    let expires_at = chrono::Utc::now() + chrono::Duration::days(state.config.session_ttl_days);
    sqlx::query("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)")
        .bind(user.id)
        .bind(hash_token(&token))
        .bind(expires_at)
        .execute(&state.pool)
        .await?;

    tracing::info!(user_id = %user.id, "user logged in");
    Ok(Json(AuthResponse {
        token,
        user: user.into(),
        session_expires_at: expires_at,
    }))
}

pub async fn logout(State(state): State<AppState>, auth: AuthUser) -> AppResult<StatusCode> {
    sqlx::query("UPDATE sessions SET revoked_at = now() WHERE id = $1")
        .bind(auth.session_id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
pub struct MeResponse {
    pub user: PublicUser,
    pub communities: Vec<Uuid>,
}

pub async fn me(State(state): State<AppState>, auth: AuthUser) -> AppResult<Json<MeResponse>> {
    let communities: Vec<(Uuid,)> =
        sqlx::query_as("SELECT community_id FROM community_members WHERE user_id = $1")
            .bind(auth.user.id)
            .fetch_all(&state.pool)
            .await?;
    Ok(Json(MeResponse {
        user: auth.user.into(),
        communities: communities.into_iter().map(|(id,)| id).collect(),
    }))
}
