use std::path::PathBuf;

use axum::{
    extract::{Multipart, Path, State},
    Json,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    auth::AuthUser,
    db::{self, PublicUser, User},
    error::{AppError, AppResult},
    state::AppState,
    ws::protocol::{MemberUpdated, OutboundEnvelope},
};

const AVATAR_CONTENT_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_AVATAR_BYTES: usize = 8 * 1024 * 1024;

#[derive(Deserialize)]
pub struct RenameRequest {
    pub display_name: String,
}

#[derive(Deserialize)]
pub struct NameColorRequest {
    /// Hex `#rgb` / `#rrggbb`, or `null` to clear back to the default.
    pub name_color: Option<String>,
}

/// PROFILE-FR: set a member's display-name colour (your own or anyone else's,
/// same "qualquer membro" scoping as rename). `null` resets to the default.
pub async fn set_name_color(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(target_id): Path<Uuid>,
    Json(req): Json<NameColorRequest>,
) -> AppResult<Json<PublicUser>> {
    let color = match req.name_color.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(value) if is_hex_color(value) => Some(value.to_ascii_lowercase()),
        Some(_) => return Err(AppError::Validation("name_color must be a #rgb or #rrggbb hex value".into())),
        None => None,
    };
    if target_id != auth.user.id && !shares_community(&state, auth.user.id, target_id).await? {
        return Err(AppError::Forbidden);
    }
    let user = sqlx::query_as::<_, User>("UPDATE users SET name_color = $1 WHERE id = $2 RETURNING *")
        .bind(color)
        .bind(target_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(AppError::NotFound)?;
    broadcast_member_updated(&state, &user).await;
    Ok(Json(user.into()))
}

fn is_hex_color(value: &str) -> bool {
    let Some(hex) = value.strip_prefix('#') else { return false };
    (hex.len() == 3 || hex.len() == 6) && hex.bytes().all(|b| b.is_ascii_hexdigit())
}

/// PROFILE-FR: rename yourself. Any authenticated user may change their own
/// `display_name`; the new row is fanned out to everyone who shares a
/// community with them so rosters/message authors update live.
pub async fn update_me(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(req): Json<RenameRequest>,
) -> AppResult<Json<PublicUser>> {
    let name = validate_display_name(&req.display_name)?;
    let user = set_display_name(&state, auth.user.id, &name).await?;
    broadcast_member_updated(&state, &user).await;
    Ok(Json(user.into()))
}

/// PROFILE-FR: rename another member. v1's community is a small circle of
/// friends, so any member may rename any other member they share a community
/// with (see the "qualquer membro" scoping decision) — there is no
/// delete/kick counterpart, only the name.
pub async fn rename_user(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(target_id): Path<Uuid>,
    Json(req): Json<RenameRequest>,
) -> AppResult<Json<PublicUser>> {
    let name = validate_display_name(&req.display_name)?;
    if !shares_community(&state, auth.user.id, target_id).await? {
        return Err(AppError::Forbidden);
    }
    let user = set_display_name(&state, target_id, &name).await?;
    broadcast_member_updated(&state, &user).await;
    Ok(Json(user.into()))
}

/// PROFILE-FR: replace your own avatar. Single allowlisted image field named
/// `file`; stored under `<attachments>/avatars/<user_id>` (server-named, so a
/// re-upload overwrites in place).
pub async fn upload_avatar(
    State(state): State<AppState>,
    auth: AuthUser,
    mut multipart: Multipart,
) -> AppResult<Json<PublicUser>> {
    let field = multipart
        .next_field()
        .await
        .map_err(|_| AppError::Validation("invalid multipart body".into()))?
        .ok_or_else(|| AppError::Validation("file is required".into()))?;
    if field.name() != Some("file") {
        return Err(AppError::Validation("multipart field must be named file".into()));
    }
    let content_type = field
        .content_type()
        .map(|value| value.to_string())
        .unwrap_or_default();
    if !AVATAR_CONTENT_TYPES.contains(&content_type.as_str()) {
        return Err(AppError::Validation("avatar must be a png, jpeg, gif or webp image".into()));
    }
    let bytes = field
        .bytes()
        .await
        .map_err(|_| AppError::Validation("failed to read uploaded file".into()))?;
    if bytes.is_empty() {
        return Err(AppError::Validation("avatar image is empty".into()));
    }
    if bytes.len() > MAX_AVATAR_BYTES {
        return Err(AppError::PayloadTooLarge);
    }
    if multipart
        .next_field()
        .await
        .map_err(|_| AppError::Validation("invalid multipart body".into()))?
        .is_some()
    {
        return Err(AppError::Validation("only one image per upload is allowed".into()));
    }

    let dir = PathBuf::from(&state.config.attachment_storage_path).join("avatars");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|error| AppError::Internal(anyhow::anyhow!("failed to prepare avatar store: {error}")))?;
    let storage_path = dir.join(auth.user.id.to_string());
    tokio::fs::write(&storage_path, &bytes)
        .await
        .map_err(|error| AppError::Internal(anyhow::anyhow!("failed to store avatar: {error}")))?;

    let user = sqlx::query_as::<_, User>(
        "UPDATE users SET avatar_storage_path = $1, avatar_content_type = $2 WHERE id = $3 RETURNING *",
    )
    .bind(storage_path.to_string_lossy().as_ref())
    .bind(&content_type)
    .bind(auth.user.id)
    .fetch_one(&state.pool)
    .await?;
    broadcast_member_updated(&state, &user).await;
    Ok(Json(user.into()))
}

async fn set_display_name(state: &AppState, user_id: Uuid, name: &str) -> AppResult<User> {
    sqlx::query_as::<_, User>("UPDATE users SET display_name = $1 WHERE id = $2 RETURNING *")
        .bind(name)
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(AppError::NotFound)
}

async fn shares_community(state: &AppState, actor: Uuid, target: Uuid) -> AppResult<bool> {
    let row: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM community_members a JOIN community_members b \
           ON a.community_id = b.community_id \
         WHERE a.user_id = $1 AND b.user_id = $2 LIMIT 1",
    )
    .bind(actor)
    .bind(target)
    .fetch_optional(&state.pool)
    .await?;
    Ok(row.is_some())
}

pub async fn broadcast_member_updated(state: &AppState, user: &User) {
    let public: PublicUser = user.clone().into();
    let role = match sqlx::query_scalar::<_, String>(
        "SELECT role FROM community_members WHERE user_id = $1 LIMIT 1",
    )
    .bind(user.id)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(Some(r)) => r,
        _ => "member".to_string(),
    };

    match db::related_member_ids(&state.pool, user.id).await {
        Ok(recipients) => {
            state
                .hub
                .broadcast_to(
                    &recipients,
                    OutboundEnvelope::new(
                        "member.updated",
                        MemberUpdated {
                            user_id: public.id,
                            username: public.username,
                            display_name: public.display_name,
                            avatar_url: public.avatar_url,
                            avatar_color: public.avatar_color,
                            profile_tag: public.profile_tag,
                            name_color: public.name_color,
                            role,
                        },
                    ),
                )
                .await
        }
        Err(error) => tracing::error!(user_id = %user.id, %error, "failed to resolve member.updated recipients"),
    }
}

fn validate_display_name(name: &str) -> AppResult<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 80 {
        return Err(AppError::Validation("display name must be 1..=80 characters".into()));
    }
    Ok(trimmed.to_string())
}
