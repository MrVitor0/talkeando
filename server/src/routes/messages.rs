use axum::{
    extract::{Path, Query, State},
    Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    auth::AuthUser,
    db::{self, PublicUser},
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

#[derive(Serialize)]
pub struct HistoryResponse {
    pub messages: Vec<HistoryMessage>,
    pub has_more: bool,
}

#[derive(Serialize)]
pub struct HistoryMessage {
    pub id: Uuid,
    pub channel_id: Uuid,
    pub author: PublicUser,
    pub content: String,
    pub created_at: DateTime<Utc>,
    pub edited_at: Option<DateTime<Utc>>,
    pub attachments: Vec<MessageAttachment>,
    pub link_preview: Option<LinkPreview>,
    pub embeds: Vec<MessageEmbedDto>,
}

#[derive(Clone, Serialize, sqlx::FromRow)]
pub struct LinkPreview {
    pub url: String,
    pub title: Option<String>,
    pub site_name: Option<String>,
    pub image_url: Option<String>,
}

/// A rich embed imported from Discord (bot polls, "now playing", changelog
/// cards). See migration 0007 and `discord_import::import_json`.
#[derive(Clone, Serialize)]
pub struct MessageEmbedDto {
    pub title: Option<String>,
    pub description: Option<String>,
    pub url: Option<String>,
    pub color: Option<i32>,
    pub author_name: Option<String>,
    pub author_url: Option<String>,
    pub provider_name: Option<String>,
    pub footer_text: Option<String>,
    pub footer_icon_url: Option<String>,
    pub image_url: Option<String>,
    pub thumbnail_url: Option<String>,
    pub fields: serde_json::Value,
}

#[derive(sqlx::FromRow)]
struct EmbedRow {
    message_id: Uuid,
    title: Option<String>,
    description: Option<String>,
    url: Option<String>,
    color: Option<i32>,
    author_name: Option<String>,
    author_url: Option<String>,
    provider_name: Option<String>,
    footer_text: Option<String>,
    fields: serde_json::Value,
    image_url: Option<String>,
    thumbnail_url: Option<String>,
    footer_icon_url: Option<String>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct MessageAttachment {
    pub id: Uuid,
    pub filename: String,
    pub content_type: String,
    pub size_bytes: i64,
    pub url: String,
}

#[derive(sqlx::FromRow)]
struct HistoryRow {
    id: Uuid,
    channel_id: Uuid,
    author_id: Uuid,
    content: String,
    created_at: DateTime<Utc>,
    edited_at: Option<DateTime<Utc>>,
    username: String,
    display_name: String,
    avatar_color: Option<String>,
    avatar_url: Option<String>,
    profile_tag: Option<String>,
    profile_badge_url: Option<String>,
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
) -> AppResult<Json<HistoryResponse>> {
    let channel = db::channel_if_member(&state.pool, channel_id, auth.user.id)
        .await?
        .ok_or(AppError::Forbidden)?;
    if channel.kind != "text" {
        return Err(AppError::Validation("message history is only available for text channels".into()));
    }
    let limit = q.limit.clamp(1, 100);

    // Fetch one extra row, so the client can tell whether another backfill
    // request is useful without relying on an unstable offset.
    let mut rows = match q.before {
        Some(before_id) => {
            sqlx::query_as::<_, HistoryRow>(
                "SELECT m.id, m.channel_id, m.author_id, m.content, m.created_at, m.edited_at, \
                        u.username, u.display_name, u.avatar_color, \
                        CASE WHEN u.avatar_storage_path IS NULL THEN NULL ELSE '/api/users/' || u.id::text || '/avatar' END AS avatar_url, u.profile_tag, \
                        CASE WHEN u.profile_badge_storage_path IS NULL THEN NULL ELSE '/api/users/' || u.id::text || '/profile-badge' END AS profile_badge_url \
                 FROM messages m JOIN users u ON u.id = m.author_id \
                 WHERE m.channel_id = $1 AND m.deleted_at IS NULL \
                 AND (m.created_at, m.id) < (SELECT created_at, id FROM messages WHERE id = $2 AND channel_id = $1) \
                 ORDER BY m.created_at DESC, m.id DESC LIMIT $3",
            )
            .bind(channel_id)
            .bind(before_id)
            .bind(limit + 1)
            .fetch_all(&state.pool)
            .await?
        }
        None => {
            sqlx::query_as::<_, HistoryRow>(
                "SELECT m.id, m.channel_id, m.author_id, m.content, m.created_at, m.edited_at, \
                        u.username, u.display_name, u.avatar_color, \
                        CASE WHEN u.avatar_storage_path IS NULL THEN NULL ELSE '/api/users/' || u.id::text || '/avatar' END AS avatar_url, u.profile_tag, \
                        CASE WHEN u.profile_badge_storage_path IS NULL THEN NULL ELSE '/api/users/' || u.id::text || '/profile-badge' END AS profile_badge_url \
                 FROM messages m JOIN users u ON u.id = m.author_id \
                 WHERE m.channel_id = $1 AND m.deleted_at IS NULL \
                 ORDER BY m.created_at DESC, m.id DESC LIMIT $2",
            )
            .bind(channel_id)
            .bind(limit + 1)
            .fetch_all(&state.pool)
            .await?
        }
    };

    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let message_ids: Vec<Uuid> = rows.iter().map(|row| row.id).collect();
    let attachment_rows = sqlx::query_as::<_, AttachmentRow>(
        "SELECT id, message_id, filename, content_type, size_bytes FROM attachments \
         WHERE message_id = ANY($1) ORDER BY created_at ASC",
    )
    .bind(&message_ids)
    .fetch_all(&state.pool)
    .await?;

    let preview_rows = sqlx::query_as::<_, PreviewRow>(
        "SELECT message_id, url, title, site_name, CASE WHEN image_storage_path IS NULL THEN NULL ELSE '/api/messages/' || message_id::text || '/preview-image' END AS image_url \
         FROM message_link_previews WHERE message_id = ANY($1)",
    ).bind(&message_ids).fetch_all(&state.pool).await?;
    let previews_by_message: std::collections::HashMap<Uuid, LinkPreview> = preview_rows.into_iter().map(|preview| (
        preview.message_id,
        LinkPreview { url: preview.url, title: preview.title, site_name: preview.site_name, image_url: preview.image_url },
    )).collect();

    let embed_rows = sqlx::query_as::<_, EmbedRow>(
        "SELECT message_id, title, description, url, color, author_name, author_url, provider_name, footer_text, fields, \
                CASE WHEN image_storage_path IS NULL THEN NULL ELSE '/api/message-embeds/' || id::text || '/image' END AS image_url, \
                CASE WHEN thumbnail_storage_path IS NULL THEN NULL ELSE '/api/message-embeds/' || id::text || '/thumbnail' END AS thumbnail_url, \
                CASE WHEN footer_icon_storage_path IS NULL THEN NULL ELSE '/api/message-embeds/' || id::text || '/footer-icon' END AS footer_icon_url \
         FROM message_embeds WHERE message_id = ANY($1) ORDER BY message_id, position",
    ).bind(&message_ids).fetch_all(&state.pool).await?;
    let mut embeds_by_message = std::collections::HashMap::<Uuid, Vec<MessageEmbedDto>>::new();
    for embed in embed_rows {
        embeds_by_message.entry(embed.message_id).or_default().push(MessageEmbedDto {
            title: embed.title,
            description: embed.description,
            url: embed.url,
            color: embed.color,
            author_name: embed.author_name,
            author_url: embed.author_url,
            provider_name: embed.provider_name,
            footer_text: embed.footer_text,
            footer_icon_url: embed.footer_icon_url,
            image_url: embed.image_url,
            thumbnail_url: embed.thumbnail_url,
            fields: embed.fields,
        });
    }

    let mut attachments_by_message = std::collections::HashMap::<Uuid, Vec<MessageAttachment>>::new();
    for attachment in attachment_rows {
        attachments_by_message.entry(attachment.message_id).or_default().push(MessageAttachment {
            id: attachment.id,
            filename: attachment.filename,
            content_type: attachment.content_type,
            size_bytes: attachment.size_bytes,
            url: format!("/api/attachments/{}", attachment.id),
        });
    }
    // The keyset query above fetches the *latest* `limit` rows newest-first;
    // flip to chronological so the client renders oldest→newest, matching how
    // live `chat.message.created` events are appended to the bottom.
    rows.reverse();
    let messages = rows.into_iter().map(|row| HistoryMessage {
        id: row.id,
        channel_id: row.channel_id,
        author: PublicUser {
            id: row.author_id,
            username: row.username,
            display_name: row.display_name,
            avatar_color: row.avatar_color,
            avatar_url: row.avatar_url,
            profile_tag: row.profile_tag,
            profile_badge_url: row.profile_badge_url,
        },
        content: row.content,
        created_at: row.created_at,
        edited_at: row.edited_at,
            attachments: attachments_by_message.remove(&row.id).unwrap_or_default(),
            link_preview: previews_by_message.get(&row.id).cloned(),
            embeds: embeds_by_message.remove(&row.id).unwrap_or_default(),
    }).collect();

    Ok(Json(HistoryResponse { messages, has_more }))
}

#[derive(sqlx::FromRow)]
struct AttachmentRow {
    id: Uuid,
    message_id: Uuid,
    filename: String,
    content_type: String,
    size_bytes: i64,
}

#[derive(sqlx::FromRow)]
struct PreviewRow {
    message_id: Uuid,
    url: String,
    title: Option<String>,
    site_name: Option<String>,
    image_url: Option<String>,
}
