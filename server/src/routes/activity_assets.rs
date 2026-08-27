//! Content-addressed store for activity artwork (game icons the native
//! client extracts from a `.exe` — SDD/specs/activity.md ACT-FR-022). Files
//! are keyed by the SHA-256 of their bytes, so uploading the same icon twice
//! is a no-op and the id can be cached forever by the client.
//!
//! `GET` is deliberately unauthenticated: the id is an unguessable content
//! hash, the payload is a game icon (no sensitivity), and the WebView UI
//! that renders it as an `<img>` has no session token to present. `POST`
//! still requires a logged-in member.

use std::path::PathBuf;

use axum::{
    body::Body,
    extract::{Multipart, Path, State},
    http::{header, HeaderValue, Response, StatusCode},
    Json,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    state::AppState,
};

const MAX_ASSET_BYTES: usize = 512 * 1024;
const ALLOWED_TYPES: &[&str] = &["image/png", "image/jpeg"];

#[derive(Serialize)]
pub struct AssetResponse {
    pub id: String,
}

pub fn asset_dir(state: &AppState) -> PathBuf {
    PathBuf::from(&state.config.attachment_storage_path).join("_activity_assets")
}

fn is_hex_hash(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

pub async fn upload(
    State(state): State<AppState>,
    _auth: AuthUser,
    mut multipart: Multipart,
) -> AppResult<(StatusCode, Json<AssetResponse>)> {
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
    if !ALLOWED_TYPES.contains(&content_type.as_str()) {
        return Err(AppError::Validation("activity assets must be png or jpeg".into()));
    }
    let bytes = field
        .bytes()
        .await
        .map_err(|_| AppError::Validation("failed to read uploaded file".into()))?;
    if bytes.is_empty() {
        return Err(AppError::Validation("asset is empty".into()));
    }
    if bytes.len() > MAX_ASSET_BYTES {
        return Err(AppError::PayloadTooLarge);
    }

    let id = hex::encode(Sha256::digest(&bytes));
    let dir = asset_dir(&state);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|error| AppError::Internal(anyhow::anyhow!("failed to prepare asset dir: {error}")))?;
    let path = dir.join(&id);
    if tokio::fs::metadata(&path).await.is_err() {
        tokio::fs::write(&path, &bytes)
            .await
            .map_err(|error| AppError::Internal(anyhow::anyhow!("failed to store asset: {error}")))?;
    }
    Ok((StatusCode::CREATED, Json(AssetResponse { id })))
}

pub async fn download(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Response<Body>> {
    if !is_hex_hash(&id) {
        return Err(AppError::NotFound);
    }
    let bytes = tokio::fs::read(asset_dir(&state).join(&id))
        .await
        .map_err(|_| AppError::NotFound)?;
    // PNG and JPEG both start distinctively; sniff so the one endpoint serves
    // either without tracking the type.
    let content_type = if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) { "image/jpeg" } else { "image/png" };
    let mut response = Response::new(Body::from(bytes));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=604800, immutable"),
    );
    Ok(response)
}
