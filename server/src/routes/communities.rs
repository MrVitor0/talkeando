use axum::{extract::State, Json};
use serde::Serialize;
use uuid::Uuid;

use crate::{auth::AuthUser, db::Community, error::AppResult, state::AppState};

pub async fn list(State(state): State<AppState>, auth: AuthUser) -> AppResult<Json<Vec<Community>>> {
    let communities = sqlx::query_as::<_, Community>(
        "SELECT c.* FROM communities c \
         JOIN community_members cm ON cm.community_id = c.id \
         WHERE cm.user_id = $1 ORDER BY c.created_at",
    )
    .bind(auth.user.id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(communities))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct CommunityMember {
    pub id: Uuid,
    pub username: String,
    pub display_name: String,
    pub avatar_color: Option<String>,
    pub avatar_url: Option<String>,
    pub profile_tag: Option<String>,
    pub profile_badge_url: Option<String>,
    pub name_color: Option<String>,
    pub role: String,
}

#[derive(Serialize)]
pub struct CurrentCommunityResponse {
    pub id: Uuid,
    pub name: String,
    pub members: Vec<CommunityMember>,
}

/// Canonical single-community v1 endpoint. Membership is inferred from the
/// session; no community id from the client is trusted or required.
pub async fn current(
    State(state): State<AppState>,
    auth: AuthUser,
) -> AppResult<Json<CurrentCommunityResponse>> {
    let community = sqlx::query_as::<_, Community>(
        "SELECT c.* FROM communities c JOIN community_members cm ON cm.community_id = c.id \
         WHERE cm.user_id = $1 ORDER BY cm.joined_at LIMIT 1",
    )
    .bind(auth.user.id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(crate::error::AppError::Forbidden)?;
    let members = sqlx::query_as::<_, CommunityMember>(
        "SELECT u.id, u.username, u.display_name, u.avatar_color, \
                CASE WHEN u.avatar_storage_path IS NULL THEN NULL ELSE '/api/users/' || u.id::text || '/avatar' END AS avatar_url, \
                u.profile_tag, CASE WHEN u.profile_badge_storage_path IS NULL THEN NULL ELSE '/api/users/' || u.id::text || '/profile-badge' END AS profile_badge_url, u.name_color, cm.role \
         FROM community_members cm JOIN users u ON u.id = cm.user_id \
         WHERE cm.community_id = $1 ORDER BY u.username",
    )
    .bind(community.id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(CurrentCommunityResponse {
        id: community.id,
        name: community.name,
        members,
    }))
}
