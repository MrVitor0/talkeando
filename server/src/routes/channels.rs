use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    auth::AuthUser,
    db::{self, Channel, ChannelCategory},
    error::{AppError, AppResult},
    state::AppState,
    ws::protocol::{ChannelUpdated, OutboundEnvelope},
};

#[derive(Serialize)]
pub struct ChannelsResponse {
    pub categories: Vec<ChannelCategory>,
    pub channels: Vec<Channel>,
}

#[derive(Deserialize)]
pub struct CreateCategoryRequest {
    pub name: String,
    pub position: Option<i32>,
}

#[derive(Deserialize)]
pub struct UpdateCategoryRequest {
    pub name: Option<String>,
    pub position: Option<i32>,
}

#[derive(Deserialize)]
pub struct CreateChannelRequest {
    pub name: String,
    pub kind: String,
    pub category_id: Option<Uuid>,
    pub topic: Option<String>,
    pub position: Option<i32>,
}

#[derive(Deserialize)]
pub struct UpdateChannelRequest {
    pub name: Option<String>,
    pub topic: Option<String>,
    /// `None` means unchanged; `Some(None)` explicitly makes the channel
    /// uncategorized, which is distinct from omitting the field in PATCH.
    pub category_id: Option<Option<Uuid>>,
    pub position: Option<i32>,
}

#[derive(Serialize)]
pub struct CategoryWithChannels {
    pub id: Uuid,
    pub name: String,
    pub position: i32,
    pub channels: Vec<Channel>,
}

#[derive(Serialize)]
pub struct CurrentCommunityChannelsResponse {
    pub categories: Vec<CategoryWithChannels>,
    pub uncategorized_channels: Vec<Channel>,
}

/// CHAN-FR-001 canonical endpoint. The v1 product has exactly one community,
/// so callers do not select an id; their sole membership determines it.
pub async fn list(
    State(state): State<AppState>,
    auth: AuthUser,
) -> AppResult<Json<CurrentCommunityChannelsResponse>> {
    let community_id: Option<(Uuid,)> = sqlx::query_as(
        "SELECT community_id FROM community_members WHERE user_id = $1 ORDER BY joined_at LIMIT 1",
    )
    .bind(auth.user.id)
    .fetch_optional(&state.pool)
    .await?;
    let Some((community_id,)) = community_id else {
        return Err(AppError::Forbidden);
    };

    let response = channel_structure(&state, community_id).await?;
    Ok(Json(response))
}

/// CHAN-FR-002: owner-only category creation. Positions default to append.
pub async fn create_category(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(req): Json<CreateCategoryRequest>,
) -> AppResult<(StatusCode, Json<ChannelCategory>)> {
    let community_id = owner_community_id(&state, auth.user.id).await?;
    validate_name(&req.name, "category name")?;
    let category = sqlx::query_as::<_, ChannelCategory>(
        "INSERT INTO channel_categories (community_id, name, position) \
         VALUES ($1, $2, COALESCE($3, (SELECT COALESCE(MAX(position) + 1, 0) FROM channel_categories WHERE community_id = $1))) \
         RETURNING *",
    )
    .bind(community_id)
    .bind(req.name.trim())
    .bind(req.position)
    .fetch_one(&state.pool)
    .await?;
    tracing::info!(actor_user_id = %auth.user.id, category_id = %category.id, "channel category created");
    Ok((StatusCode::CREATED, Json(category)))
}

pub async fn update_category(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(category_id): Path<Uuid>,
    Json(req): Json<UpdateCategoryRequest>,
) -> AppResult<Json<ChannelCategory>> {
    let community_id = owner_community_id(&state, auth.user.id).await?;
    if let Some(name) = &req.name { validate_name(name, "category name")?; }
    if req.name.is_none() && req.position.is_none() {
        return Err(AppError::Validation("at least one field is required".into()));
    }
    let category = sqlx::query_as::<_, ChannelCategory>(
        "UPDATE channel_categories SET name = COALESCE($1, name), position = COALESCE($2, position) \
         WHERE id = $3 AND community_id = $4 RETURNING *",
    )
    .bind(req.name.as_deref().map(str::trim))
    .bind(req.position)
    .bind(category_id)
    .bind(community_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    tracing::info!(actor_user_id = %auth.user.id, category_id = %category.id, "channel category updated");
    Ok(Json(category))
}

pub async fn delete_category(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(category_id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let community_id = owner_community_id(&state, auth.user.id).await?;
    let mut tx = state.pool.begin().await?;
    let deleted: Option<(Uuid,)> = sqlx::query_as(
        "DELETE FROM channel_categories WHERE id = $1 AND community_id = $2 RETURNING id",
    )
    .bind(category_id)
    .bind(community_id)
    .fetch_optional(&mut *tx)
    .await?;
    if deleted.is_none() { return Err(AppError::NotFound); }
    sqlx::query("UPDATE channels SET category_id = NULL WHERE category_id = $1")
        .bind(category_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    tracing::info!(actor_user_id = %auth.user.id, %category_id, "channel category deleted");
    Ok(StatusCode::NO_CONTENT)
}

pub async fn create(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(req): Json<CreateChannelRequest>,
) -> AppResult<(StatusCode, Json<Channel>)> {
    let community_id = owner_community_id(&state, auth.user.id).await?;
    validate_name(&req.name, "channel name")?;
    if req.kind != "text" && req.kind != "voice" {
        return Err(AppError::Validation("kind must be text or voice".into()));
    }
    validate_category(&state, community_id, req.category_id).await?;
    let channel = sqlx::query_as::<_, Channel>(
        "INSERT INTO channels (community_id, category_id, name, kind, topic, position) \
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, (SELECT COALESCE(MAX(position) + 1, 0) FROM channels WHERE community_id = $1))) \
         RETURNING *",
    )
    .bind(community_id)
    .bind(req.category_id)
    .bind(req.name.trim())
    .bind(req.kind)
    .bind(req.topic.as_deref().map(str::trim).filter(|s| !s.is_empty()))
    .bind(req.position)
    .fetch_one(&state.pool)
    .await?;
    tracing::info!(actor_user_id = %auth.user.id, channel_id = %channel.id, "channel created");
    Ok((StatusCode::CREATED, Json(channel)))
}

pub async fn update(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<Uuid>,
    Json(req): Json<UpdateChannelRequest>,
) -> AppResult<Json<Channel>> {
    let community_id = owner_community_id(&state, auth.user.id).await?;
    if let Some(name) = &req.name { validate_name(name, "channel name")?; }
    if req.name.is_none() && req.topic.is_none() && req.category_id.is_none() && req.position.is_none() {
        return Err(AppError::Validation("at least one field is required".into()));
    }
    if let Some(category_id) = req.category_id {
        validate_category(&state, community_id, category_id).await?;
    }
    let channel = sqlx::query_as::<_, Channel>(
        "UPDATE channels SET name = COALESCE($1, name), topic = COALESCE($2, topic), \
         category_id = CASE WHEN $3 THEN $4 ELSE category_id END, position = COALESCE($5, position) \
         WHERE id = $6 AND community_id = $7 RETURNING *",
    )
    .bind(req.name.as_deref().map(str::trim))
    .bind(req.topic.as_deref().map(str::trim))
    .bind(req.category_id.is_some())
    .bind(req.category_id.flatten())
    .bind(req.position)
    .bind(channel_id)
    .bind(community_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    tracing::info!(actor_user_id = %auth.user.id, channel_id = %channel.id, "channel updated");
    Ok(Json(channel))
}

#[derive(Deserialize)]
pub struct RenameChannelRequest {
    pub name: String,
}

/// CHAN-FR (rename): unlike `update`/`delete`, which stay owner-only, any
/// member of the channel's community may change just its `name` (the
/// "qualquer membro" scoping decision — there is deliberately no member-level
/// delete). Broadcasts `channel.updated` so every sidebar re-labels live.
pub async fn rename(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<Uuid>,
    Json(req): Json<RenameChannelRequest>,
) -> AppResult<Json<Channel>> {
    validate_name(&req.name, "channel name")?;
    // Membership gate: returns the channel only if the caller belongs to the
    // community that owns it.
    let channel = db::channel_if_member(&state.pool, channel_id, auth.user.id)
        .await?
        .ok_or(AppError::Forbidden)?;
    let channel = sqlx::query_as::<_, Channel>(
        "UPDATE channels SET name = $1 WHERE id = $2 AND community_id = $3 RETURNING *",
    )
    .bind(req.name.trim())
    .bind(channel_id)
    .bind(channel.community_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    tracing::info!(actor_user_id = %auth.user.id, channel_id = %channel.id, "channel renamed");

    if let Ok(recipients) = db::community_member_ids(&state.pool, channel.community_id).await {
        state
            .hub
            .broadcast_to(
                &recipients,
                OutboundEnvelope::new(
                    "channel.updated",
                    ChannelUpdated {
                        id: channel.id,
                        name: channel.name.clone(),
                        kind: channel.kind.clone(),
                        category_id: channel.category_id,
                    },
                ),
            )
            .await;
    }
    Ok(Json(channel))
}

pub async fn delete(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let community_id = owner_community_id(&state, auth.user.id).await?;
    let deleted: Option<(Uuid, String)> = sqlx::query_as(
        "DELETE FROM channels WHERE id = $1 AND community_id = $2 RETURNING id, kind",
    )
    .bind(channel_id)
    .bind(community_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some((_id, kind)) = deleted else { return Err(AppError::NotFound); };
    if kind == "voice" {
        state.hub.calls.write().await.clear_channel(channel_id);
    }
    tracing::info!(actor_user_id = %auth.user.id, %channel_id, "channel deleted");
    Ok(StatusCode::NO_CONTENT)
}

/// CHAN-FR-001/002: any community member sees every channel in that
/// community (v1 has no per-channel visibility restriction — see
/// SDD/07-database-design.md's channel_members scope-cut note).
pub async fn list_for_community(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(community_id): Path<Uuid>,
) -> AppResult<Json<ChannelsResponse>> {
    let is_member: Option<(Uuid,)> = sqlx::query_as(
        "SELECT user_id FROM community_members WHERE community_id = $1 AND user_id = $2",
    )
    .bind(community_id)
    .bind(auth.user.id)
    .fetch_optional(&state.pool)
    .await?;
    if is_member.is_none() {
        return Err(AppError::Forbidden);
    }

    let categories = sqlx::query_as::<_, ChannelCategory>(
        "SELECT * FROM channel_categories WHERE community_id = $1 ORDER BY position",
    )
    .bind(community_id)
    .fetch_all(&state.pool)
    .await?;

    let channels = sqlx::query_as::<_, Channel>(
        "SELECT * FROM channels WHERE community_id = $1 ORDER BY position",
    )
    .bind(community_id)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(ChannelsResponse { categories, channels }))
}

async fn channel_structure(
    state: &AppState,
    community_id: Uuid,
) -> AppResult<CurrentCommunityChannelsResponse> {
    let categories = sqlx::query_as::<_, ChannelCategory>(
        "SELECT * FROM channel_categories WHERE community_id = $1 ORDER BY position, id",
    )
    .bind(community_id)
    .fetch_all(&state.pool)
    .await?;
    let channels = sqlx::query_as::<_, Channel>(
        "SELECT * FROM channels WHERE community_id = $1 AND (topic IS NULL OR NOT topic LIKE 'dm:%') ORDER BY position, id",
    )
    .bind(community_id)
    .fetch_all(&state.pool)
    .await?;

    let mut by_category: std::collections::HashMap<Uuid, Vec<Channel>> =
        std::collections::HashMap::new();
    let mut uncategorized_channels = Vec::new();
    for channel in channels {
        match channel.category_id {
            Some(category_id) => by_category.entry(category_id).or_default().push(channel),
            None => uncategorized_channels.push(channel),
        }
    }

    let categories = categories
        .into_iter()
        .map(|category| CategoryWithChannels {
            id: category.id,
            name: category.name,
            position: category.position,
            channels: by_category.remove(&category.id).unwrap_or_default(),
        })
        .collect();
    Ok(CurrentCommunityChannelsResponse {
        categories,
        uncategorized_channels,
    })
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

async fn validate_category(
    state: &AppState,
    community_id: Uuid,
    category_id: Option<Uuid>,
) -> AppResult<()> {
    let Some(category_id) = category_id else { return Ok(()); };
    let exists: Option<(Uuid,)> = sqlx::query_as(
        "SELECT id FROM channel_categories WHERE id = $1 AND community_id = $2",
    )
    .bind(category_id)
    .bind(community_id)
    .fetch_optional(&state.pool)
    .await?;
    if exists.is_none() {
        return Err(AppError::Validation("category does not belong to this community".into()));
    }
    Ok(())
}

fn validate_name(name: &str, field: &str) -> AppResult<()> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 100 {
        return Err(AppError::Validation(format!("{field} must be 1..=100 characters")));
    }
    Ok(())
}

/// Open or retrieve a 1:1 Direct Message channel with a member.
pub async fn open_dm(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(target_user_id): Path<Uuid>,
) -> AppResult<Json<Channel>> {
    if auth.user.id == target_user_id {
        return Err(AppError::Validation("cannot open DM with yourself".into()));
    }

    let community_id: Option<(Uuid,)> = sqlx::query_as(
        "SELECT community_id FROM community_members WHERE user_id = $1 ORDER BY joined_at LIMIT 1",
    )
    .bind(auth.user.id)
    .fetch_optional(&state.pool)
    .await?;

    let Some((community_id,)) = community_id else {
        return Err(AppError::Forbidden);
    };

    let target_exists: Option<(Uuid,)> = sqlx::query_as(
        "SELECT id FROM users WHERE id = $1",
    )
    .bind(target_user_id)
    .fetch_optional(&state.pool)
    .await?;

    if target_exists.is_none() {
        return Err(AppError::NotFound);
    }

    let topic = if auth.user.id < target_user_id {
        format!("dm:{}:{}", auth.user.id, target_user_id)
    } else {
        format!("dm:{}:{}", target_user_id, auth.user.id)
    };

    // Find existing DM channel
    let existing = sqlx::query_as::<_, Channel>(
        "SELECT * FROM channels WHERE community_id = $1 AND topic = $2 LIMIT 1",
    )
    .bind(community_id)
    .bind(&topic)
    .fetch_optional(&state.pool)
    .await?;

    if let Some(channel) = existing {
        return Ok(Json(channel));
    }

    // Create DM channel
    let channel = sqlx::query_as::<_, Channel>(
        "INSERT INTO channels (community_id, category_id, name, kind, topic, position) \
         VALUES ($1, NULL, 'dm', 'text', $2, 9999) \
         RETURNING *",
    )
    .bind(community_id)
    .bind(&topic)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(channel))
}
