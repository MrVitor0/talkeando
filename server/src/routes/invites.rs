use axum::{extract::{Path, State}, http::StatusCode, Json};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    auth::AuthUser,
    db::Invite,
    error::{AppError, AppResult},
    state::AppState,
};

#[derive(Deserialize)]
pub struct CreateInviteRequest {
    pub community_id: Uuid,
    pub max_uses: Option<i32>,
    pub expires_in_seconds: Option<i64>,
}

#[derive(Serialize)]
pub struct InviteResponse {
    pub code: String,
}

/// AUTH-FR-001/SEC-NFR: only a community owner can mint invites, keeping
/// membership growth of this ~10-person community deliberate.
pub async fn create(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(req): Json<CreateInviteRequest>,
) -> AppResult<Json<InviteResponse>> {
    let role: Option<(String,)> = sqlx::query_as(
        "SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2",
    )
    .bind(req.community_id)
    .bind(auth.user.id)
    .fetch_optional(&state.pool)
    .await?;

    match role {
        Some((r,)) if r == "owner" => {}
        Some(_) => return Err(AppError::Forbidden),
        None => return Err(AppError::Forbidden),
    }

    let code: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(10)
        .map(char::from)
        .collect();
    let expires_at = req
        .expires_in_seconds
        .map(|seconds| chrono::Utc::now() + chrono::Duration::seconds(seconds));

    let invite = sqlx::query_as::<_, Invite>(
        "INSERT INTO invites (community_id, created_by, code, max_uses, expires_at) \
         VALUES ($1, $2, $3, $4, $5) RETURNING *",
    )
    .bind(req.community_id)
    .bind(auth.user.id)
    .bind(&code)
    .bind(req.max_uses)
    .bind(expires_at)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(InviteResponse { code: invite.code }))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct InviteListItem {
    pub id: Uuid,
    pub code: String,
    pub max_uses: Option<i32>,
    pub uses: i32,
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
}

pub async fn list(State(state): State<AppState>, auth: AuthUser) -> AppResult<Json<Vec<InviteListItem>>> {
    let community_id = owner_community_id(&state, auth.user.id).await?;
    let invites = sqlx::query_as::<_, InviteListItem>(
        "SELECT id, code, max_uses, uses, expires_at FROM invites WHERE community_id = $1 ORDER BY created_at DESC",
    )
    .bind(community_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(invites))
}

pub async fn revoke(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(invite_id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let community_id = owner_community_id(&state, auth.user.id).await?;
    let result = sqlx::query("UPDATE invites SET expires_at = now() WHERE id = $1 AND community_id = $2")
        .bind(invite_id)
        .bind(community_id)
        .execute(&state.pool)
        .await?;
    if result.rows_affected() == 0 { return Err(AppError::NotFound); }
    Ok(StatusCode::NO_CONTENT)
}

async fn owner_community_id(state: &AppState, user_id: Uuid) -> AppResult<Uuid> {
    let community: Option<(Uuid,)> = sqlx::query_as(
        "SELECT community_id FROM community_members WHERE user_id = $1 AND role = 'owner' LIMIT 1",
    )
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    community.map(|(id,)| id).ok_or(AppError::Forbidden)
}
