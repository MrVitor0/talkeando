use std::path::PathBuf;

use axum::{
    body::Body,
    extract::{Multipart, Path, State},
    http::{header, HeaderValue, Response, StatusCode},
    Json,
};
use serde::Serialize;
use uuid::Uuid;

use crate::{
    auth::AuthUser,
    db,
    error::{AppError, AppResult},
    state::AppState,
};

const ALLOWED_CONTENT_TYPES: &[&str] = &[
    "image/png", "image/jpeg", "image/jpg", "image/pjpeg", "image/gif", "image/webp", "image/svg+xml", "image/bmp",
    "video/mp4", "video/webm", "video/quicktime", "video/x-msvideo", "video/mpeg", "video/ogg",
    "audio/mpeg", "audio/mp3", "audio/ogg", "audio/wav", "audio/webm", "audio/aac", "audio/flac", "audio/mp4",
    "application/pdf", "text/plain", "text/markdown", "text/csv", "application/json",
    "application/zip", "application/x-zip-compressed", "application/octet-stream",
];

#[derive(Serialize)]
pub struct AttachmentResponse {
    pub id: Uuid,
    pub filename: String,
    pub content_type: String,
    pub size_bytes: i64,
    pub url: String,
}

#[derive(sqlx::FromRow)]
struct AttachmentFile {
    filename: String,
    content_type: String,
    size_bytes: i64,
    storage_path: String,
}

/// ATTACH-FR-001..004: accepts exactly one allowlisted file, stores it under
/// a server-generated name, and leaves it unattached until message creation.
pub async fn upload(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<Uuid>,
    mut multipart: Multipart,
) -> AppResult<(StatusCode, Json<AttachmentResponse>)> {
    let channel = db::channel_if_member(&state.pool, channel_id, auth.user.id)
        .await?
        .ok_or(AppError::Forbidden)?;
    if channel.kind != "text" {
        return Err(AppError::Validation("attachments can only be uploaded to text channels".into()));
    }

    let field = multipart
        .next_field()
        .await
        .map_err(|_| AppError::Validation("invalid multipart body".into()))?
        .ok_or_else(|| AppError::Validation("file is required".into()))?;
    if field.name() != Some("file") {
        return Err(AppError::Validation("multipart field must be named file".into()));
    }
    let original_name = field.file_name().unwrap_or("attachment");
    let filename = sanitize_filename(original_name);
    let content_type = field
        .content_type()
        .map(|content_type| content_type.to_string())
        .unwrap_or_else(|| "application/octet-stream".to_string());
    if !ALLOWED_CONTENT_TYPES.contains(&content_type.as_str()) {
        return Err(AppError::Validation("unsupported attachment content type".into()));
    }
    let bytes = field
        .bytes()
        .await
        .map_err(|_| AppError::Validation("failed to read uploaded file".into()))?;
    if bytes.is_empty() {
        return Err(AppError::Validation("attachment is empty".into()));
    }
    if bytes.len() > state.config.max_attachment_size_bytes {
        return Err(AppError::PayloadTooLarge);
    }
    if multipart.next_field().await.map_err(|_| AppError::Validation("invalid multipart body".into()))?.is_some() {
        return Err(AppError::Validation("only one attachment per upload is allowed".into()));
    }

    let id = Uuid::new_v4();
    let storage_path = attachment_path(&state, id);
    tokio::fs::write(&storage_path, &bytes)
        .await
        .map_err(|error| AppError::Internal(anyhow::anyhow!("failed to store attachment: {error}")))?;
    let inserted = sqlx::query(
        "INSERT INTO attachments (id, uploader_id, filename, content_type, size_bytes, storage_path) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(id)
    .bind(auth.user.id)
    .bind(&filename)
    .bind(&content_type)
    .bind(bytes.len() as i64)
    .bind(storage_path.to_string_lossy().as_ref())
    .execute(&state.pool)
    .await;
    if let Err(error) = inserted {
        let _ = tokio::fs::remove_file(&storage_path).await;
        return Err(AppError::Database(error));
    }
    Ok((StatusCode::CREATED, Json(AttachmentResponse {
        id,
        filename,
        content_type,
        size_bytes: bytes.len() as i64,
        url: format!("/api/attachments/{id}"),
    })))
}

pub async fn download(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(attachment_id): Path<Uuid>,
) -> AppResult<Response<Body>> {
    let attachment = sqlx::query_as::<_, AttachmentFile>(
        "SELECT a.filename, a.content_type, a.size_bytes, a.storage_path FROM attachments a \
         LEFT JOIN messages m ON m.id = a.message_id \
         LEFT JOIN channels c ON c.id = m.channel_id \
         LEFT JOIN community_members cm ON cm.community_id = c.community_id AND cm.user_id = $2 \
         WHERE a.id = $1 AND (a.uploader_id = $2 OR cm.user_id IS NOT NULL)",
    )
    .bind(attachment_id)
    .bind(auth.user.id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    let bytes = tokio::fs::read(&attachment.storage_path)
        .await
        .map_err(|_| AppError::NotFound)?;
    let disposition = format!("attachment; filename=\"{}\"", attachment.filename.replace('"', "_"));
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_str(&attachment.content_type).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    response.headers_mut().insert(header::CONTENT_DISPOSITION, HeaderValue::from_str(&disposition).unwrap_or(HeaderValue::from_static("attachment")));
    response.headers_mut().insert(header::CONTENT_LENGTH, HeaderValue::from_str(&attachment.size_bytes.to_string()).unwrap_or(HeaderValue::from_static("0")));
    Ok(response)
}

fn attachment_path(state: &AppState, id: Uuid) -> PathBuf {
    PathBuf::from(&state.config.attachment_storage_path).join(id.to_string())
}

fn sanitize_filename(filename: &str) -> String {
    let cleaned: String = filename.chars().filter(|character| !matches!(character, '/' | '\\' | '\0')).collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() { "attachment".to_string() } else { cleaned.chars().take(255).collect() }
}
