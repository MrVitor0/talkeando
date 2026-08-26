use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    auth::AuthUser,
    db::{self, Message},
    error::{AppError, AppResult},
    state::AppState,
};

#[derive(Deserialize)]
pub struct HistoryQuery {
    /// Cursor: return messages created strictly before this message's
    /// `created_at` (keyset pagination — stable under concurrent inserts,
    /// unlike offset pagination).
    pub before: Option<Uuid>,
    #[serde(default = "default_limit")]
    pub limit: i64,
}

fn default_limit() -> i64 {
    50
}

/// CHAT-FR-005: initial history load / backfill on scroll goes over REST;
/// live messages arrive over the WebSocket (see routes/mod.rs doc comment).
pub async fn history(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<Uuid>,
    Query(q): Query<HistoryQuery>,
) -> AppResult<Json<Vec<Message>>> {
    let channel = db::channel_if_member(&state.pool, channel_id, auth.user.id)
        .await?
        .ok_or(AppError::Forbidden)?;
    if channel.kind != "text" {
        return Err(AppError::Validation("message history is only available for text channels".into()));
    }
    let limit = q.limit.clamp(1, 100);

    let messages = match q.before {
        Some(before_id) => {
            sqlx::query_as::<_, Message>(
                "SELECT * FROM messages WHERE channel_id = $1 AND deleted_at IS NULL \
                 AND created_at < (SELECT created_at FROM messages WHERE id = $2 AND channel_id = $1) \
                 ORDER BY created_at DESC LIMIT $3",
            )
            .bind(channel_id)
            .bind(before_id)
            .bind(limit)
            .fetch_all(&state.pool)
            .await?
        }
        None => {
            sqlx::query_as::<_, Message>(
                "SELECT * FROM messages WHERE channel_id = $1 AND deleted_at IS NULL \
                 ORDER BY created_at DESC LIMIT $2",
            )
            .bind(channel_id)
            .bind(limit)
            .fetch_all(&state.pool)
            .await?
        }
    };

    Ok(Json(messages))
}
