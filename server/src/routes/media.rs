use axum::{body::Body, extract::{Path, State}, http::{header, HeaderValue, Response}, response::IntoResponse};
use uuid::Uuid;

use crate::{auth::AuthUser, error::{AppError, AppResult}, state::AppState};

pub async fn avatar(
    State(state): State<AppState>,
    _auth: AuthUser,
    Path(user_id): Path<Uuid>,
) -> AppResult<Response<Body>> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT avatar_storage_path, avatar_content_type FROM users WHERE id = $1 AND avatar_storage_path IS NOT NULL",
    ).bind(user_id).fetch_optional(&state.pool).await?;
    serve(row).await
}

pub async fn profile_badge(
    State(state): State<AppState>,
    _auth: AuthUser,
    Path(user_id): Path<Uuid>,
) -> AppResult<Response<Body>> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT profile_badge_storage_path, profile_badge_content_type FROM users WHERE id = $1 AND profile_badge_storage_path IS NOT NULL",
    ).bind(user_id).fetch_optional(&state.pool).await?;
    serve(row).await
}

pub async fn preview_image(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(message_id): Path<Uuid>,
) -> AppResult<Response<Body>> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT p.image_storage_path, p.image_content_type FROM message_link_previews p \
         JOIN messages m ON m.id = p.message_id JOIN channels c ON c.id = m.channel_id \
         JOIN community_members cm ON cm.community_id = c.community_id \
         WHERE p.message_id = $1 AND cm.user_id = $2 AND p.image_storage_path IS NOT NULL",
    ).bind(message_id).bind(auth.user.id).fetch_optional(&state.pool).await?;
    serve(row).await
}

/// Serves an imported rich-embed image (`slot` is `image`, `thumbnail` or
/// `footer-icon`). Access mirrors `preview_image`: the caller must belong to
/// the community that owns the embed's message.
pub async fn embed_image(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((embed_id, slot)): Path<(Uuid, String)>,
) -> AppResult<Response<Body>> {
    // Fixed allowlist — the column names below are never caller-controlled.
    let (path_col, content_type_col) = match slot.as_str() {
        "image" => ("image_storage_path", "image_content_type"),
        "thumbnail" => ("thumbnail_storage_path", "thumbnail_content_type"),
        "footer-icon" => ("footer_icon_storage_path", "footer_icon_content_type"),
        _ => return Err(AppError::NotFound),
    };
    let query = format!(
        "SELECT e.{path_col}, e.{content_type_col} FROM message_embeds e \
         JOIN messages m ON m.id = e.message_id JOIN channels c ON c.id = m.channel_id \
         JOIN community_members cm ON cm.community_id = c.community_id \
         WHERE e.id = $1 AND cm.user_id = $2 AND e.{path_col} IS NOT NULL"
    );
    let row: Option<(String, String)> = sqlx::query_as(&query)
        .bind(embed_id)
        .bind(auth.user.id)
        .fetch_optional(&state.pool)
        .await?;
    serve(row).await
}

async fn serve(row: Option<(String, String)>) -> AppResult<Response<Body>> {
    let (path, content_type) = row.ok_or(AppError::NotFound)?;
    let bytes = tokio::fs::read(path).await.map_err(|_| AppError::NotFound)?;
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_str(&content_type).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=86400"));
    Ok(response)
}
