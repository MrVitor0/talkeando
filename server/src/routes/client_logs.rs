//! Receives client diagnostics reports (SPEC-014). Stored as JSON files
//! alongside attachments, cleaned up with them.

use std::time::Duration;

use axum::{extract::State, Json};

use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    state::AppState,
};

/// Size ceiling: 500 short-field entries fit comfortably.
const MAX_BODY_BYTES: usize = 512 * 1024;
#[allow(dead_code)]
const MIN_INTERVAL: Duration = Duration::from_secs(60);

pub async fn upload(
    State(state): State<AppState>,
    auth: AuthUser,
    body: String,
) -> AppResult<Json<serde_json::Value>> {
    if body.len() > MAX_BODY_BYTES {
        return Err(AppError::PayloadTooLarge);
    }
    if !state.allow_client_log(auth.user.id).await {
        return Err(AppError::RateLimited);
    }
    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| AppError::Validation("relatório inválido".into()))?;

    let reason = parsed.get("reason").and_then(|v| v.as_str()).unwrap_or("unknown");
    let client_version = parsed.get("client_version").and_then(|v| v.as_str()).unwrap_or("unknown");
    tracing::info!(
        event = "client.diagnostics.received",
        user_id = %auth.user.id,
        reason,
        client_version,
        bytes = body.len(),
    );

    let dir = std::path::Path::new(&state.config.attachment_storage_path).join("_client_logs");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
    let name = format!(
        "{}-{}.json",
        chrono::Utc::now().format("%Y%m%dT%H%M%SZ"),
        auth.user.id
    );
    tokio::fs::write(dir.join(name), &body)
        .await
        .map_err(|e| AppError::Internal(e.into()))?;

    Ok(Json(serde_json::json!({ "ok": true })))
}
