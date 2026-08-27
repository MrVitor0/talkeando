//! One-way importer for Discord message responses already present in a HAR.
//! It never reads Discord credentials from the archive and only downloads
//! public CDN attachment URLs embedded in the captured message payloads.

use std::{collections::HashMap, path::{Path, PathBuf}};

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use reqwest::{header::{AUTHORIZATION, CONTENT_TYPE, USER_AGENT}, StatusCode};
use serde::Deserialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::{auth, config::Config};

const DISCORD_SOURCE: &str = "discord.com.har";
const DISCORD_API_BASE: &str = "https://discord.com/api/v9";

/// Explicitly approved mapping from the supplied Discord archive to the
/// channels already created in Estação Finita.
const CHANNEL_MAPPINGS: &[(&str, &str)] = &[
    ("1353746785260015647", "monitor-de-noticias"),
    ("590274170131185749", "átrio-principal"),
    ("712339355477344298", "setor-habitacional"),
    ("666381552648716317", "central-de-docs"),
    ("693929027316088873", "mercado-negro"),
    ("1511410023987675328", "black-baratheon"),
    ("695237283565142027", "comandos-de-console"),
    ("1518996513584582837", "atrio-principlarper"),
];

#[derive(Deserialize)]
struct Har { log: HarLog }
#[derive(Deserialize)]
struct HarLog { entries: Vec<HarEntry> }
#[derive(Deserialize)]
struct HarEntry { request: HarRequest, response: HarResponse }
#[derive(Deserialize)]
struct HarRequest { method: String, url: String }
#[derive(Deserialize)]
struct HarResponse { content: HarContent }
#[derive(Deserialize)]
struct HarContent { text: Option<String> }

#[derive(Clone, Deserialize)]
struct DiscordMessage {
    id: String,
    content: String,
    timestamp: String,
    edited_timestamp: Option<String>,
    author: DiscordAuthor,
    member: Option<DiscordMember>,
    #[serde(default)] attachments: Vec<DiscordAttachment>,
    #[serde(default)] embeds: Vec<DiscordEmbed>,
}
#[derive(Clone, Deserialize)]
struct DiscordAuthor {
    id: String,
    username: String,
    global_name: Option<String>,
    avatar: Option<String>,
    clan: Option<DiscordClan>,
}
#[derive(Clone, Deserialize)]
struct DiscordMember {
    nick: Option<String>,
    avatar: Option<String>,
}
#[derive(Clone, Deserialize)]
struct DiscordClan {
    tag: Option<String>,
    identity_guild_id: Option<String>,
    badge: Option<String>,
}
#[derive(Clone, Deserialize)]
struct DiscordAttachment {
    id: String,
    filename: String,
    url: String,
    content_type: Option<String>,
}
#[derive(Clone, Deserialize)]
struct DiscordEmbed {
    title: Option<String>,
    description: Option<String>,
    url: Option<String>,
    provider: Option<DiscordEmbedProvider>,
    thumbnail: Option<DiscordEmbedImage>,
    image: Option<DiscordEmbedImage>,
}
#[derive(Clone, Deserialize)]
struct DiscordEmbedProvider { name: Option<String> }
#[derive(Clone, Deserialize)]
struct DiscordEmbedImage { url: Option<String> }

pub async fn import_har(pool: &PgPool, config: &Config, har_path: &Path) -> Result<()> {
    let source = tokio::fs::read_to_string(har_path)
        .await
        .with_context(|| format!("failed to read HAR at {}", har_path.display()))?;
    let har: Har = serde_json::from_str(&source).context("invalid HAR JSON")?;
    let messages_by_channel = messages_from_har(har)?;
    let client = reqwest::Client::builder().build()?;
    tokio::fs::create_dir_all(&config.attachment_storage_path).await?;

    let mut imported_messages = 0usize;
    let mut skipped_messages = 0usize;
    let mut imported_attachments = 0usize;
    for (discord_channel_id, talkeando_channel_name) in CHANNEL_MAPPINGS {
        let Some(messages) = messages_by_channel.get(*discord_channel_id) else { continue; };
        let target_channel_id: Uuid = sqlx::query_scalar(
            "SELECT id FROM channels WHERE name = $1 AND kind = 'text' ORDER BY created_at LIMIT 1",
        )
        .bind(*talkeando_channel_name)
        .fetch_optional(pool)
        .await?
        .with_context(|| format!("target channel #{talkeando_channel_name} does not exist"))?;

        let mut ordered = messages.clone();
        ordered.sort_by_key(|message| message.timestamp.clone());
        for message in ordered {
            let existing: Option<Uuid> = sqlx::query_scalar(
                "SELECT message_id FROM imported_message_sources WHERE source = $1 AND source_message_id = $2",
            )
            .bind(DISCORD_SOURCE)
            .bind(&message.id)
            .fetch_optional(pool)
            .await?;
            let was_already_imported = existing.is_some();
            let (message_id, author_id) = match existing {
                Some(message_id) => {
                    skipped_messages += 1;
                    let author_id = sqlx::query_scalar("SELECT author_id FROM messages WHERE id = $1")
                        .bind(message_id).fetch_one(pool).await?;
                    (message_id, author_id)
                }
                None => {
                    let author_id = imported_author(pool, &message.author, message.member.as_ref()).await?;
                    let created_at = parse_timestamp(&message.timestamp)?;
                    let edited_at = message.edited_timestamp.as_deref().map(parse_timestamp).transpose()?;
                    let content = imported_content(&message);
                    let message_id = Uuid::new_v4();
                    let mut transaction = pool.begin().await?;
                    sqlx::query(
                        "INSERT INTO messages (id, channel_id, author_id, content, created_at, edited_at, client_req_id) \
                         VALUES ($1, $2, $3, $4, $5, $6, $7)",
                    )
                    .bind(message_id).bind(target_channel_id).bind(author_id).bind(content)
                    .bind(created_at).bind(edited_at).bind(format!("discord:{}", message.id))
                    .execute(&mut *transaction).await?;
                    sqlx::query(
                        "INSERT INTO imported_message_sources (source, source_message_id, message_id) VALUES ($1, $2, $3)",
                    )
                    .bind(DISCORD_SOURCE).bind(&message.id).bind(message_id)
                    .execute(&mut *transaction).await?;
                    transaction.commit().await?;
                    imported_messages += 1;
                    (message_id, author_id)
                }
            };
            if let Err(error) = import_author_avatar(pool, config, &client, author_id, &message.author).await {
                eprintln!("Skipping avatar for Discord user {}: {error:#}", message.author.id);
            }

            // A newer source (the authenticated import) may have richer data
            // than the first HAR capture. Keep the original message id while
            // replacing the temporary "Embed do Discord" text with the real
            // message body and current server nickname.
            if was_already_imported {
                let author_id = imported_author(pool, &message.author, message.member.as_ref()).await?;
                sqlx::query("UPDATE messages SET author_id = $2, content = $3, edited_at = $4 WHERE id = $1")
                    .bind(message_id)
                    .bind(author_id)
                    .bind(imported_content(&message))
                    .bind(message.edited_timestamp.as_deref().map(parse_timestamp).transpose()?)
                    .execute(pool)
                    .await?;
            }

            for attachment in &message.attachments {
                let already_imported: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM imported_attachment_sources WHERE source = $1 AND source_attachment_id = $2)",
                )
                .bind(DISCORD_SOURCE).bind(&attachment.id).fetch_one(pool).await?;
                if already_imported { continue; }
                match import_attachment(pool, config, &client, message_id, author_id, attachment).await {
                    Ok(()) => imported_attachments += 1,
                    Err(error) => eprintln!(
                        "Skipping unavailable Discord attachment {}: {error:#}",
                        attachment.id
                    ),
                }
            }
            import_embed_preview(pool, config, &client, message_id, &message.embeds).await?;
        }
    }
    println!("Discord HAR import complete: {imported_messages} messages and {imported_attachments} attachments imported; {skipped_messages} messages already existed.");
    Ok(())
}

/// Imports the complete history directly from Discord while the caller's own
/// authorised session is available. The credential is supplied by the process
/// environment, is never persisted, and is deliberately not logged.
pub async fn import_live(pool: &PgPool, config: &Config, authorization: &str) -> Result<()> {
    if authorization.trim().is_empty() { bail!("DISCORD_AUTHORIZATION is empty"); }
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Talkeando personal history migration)")
        .build()?;
    tokio::fs::create_dir_all(&config.attachment_storage_path).await?;
    let mut imported = 0usize;
    let mut updated = 0usize;
    let mut attachments = 0usize;
    for (discord_channel_id, talkeando_channel_name) in CHANNEL_MAPPINGS {
        let target_channel_id: Uuid = sqlx::query_scalar(
            "SELECT id FROM channels WHERE name = $1 AND kind = 'text' ORDER BY created_at LIMIT 1",
        )
        .bind(*talkeando_channel_name).fetch_optional(pool).await?
        .with_context(|| format!("target channel #{talkeando_channel_name} does not exist"))?;
        let mut before: Option<String> = None;
        loop {
            let mut url = format!("{DISCORD_API_BASE}/channels/{discord_channel_id}/messages?limit=100");
            if let Some(before) = &before { url.push_str("&before="); url.push_str(before); }
            let response = client.get(&url)
                .header(AUTHORIZATION, authorization)
                .header(USER_AGENT, "Mozilla/5.0 (Talkeando personal history migration)")
                .send().await?;
            if response.status() == StatusCode::TOO_MANY_REQUESTS {
                let delay = response.json::<serde_json::Value>().await.ok()
                    .and_then(|body| body.get("retry_after").and_then(|value| value.as_f64())).unwrap_or(2.0);
                tokio::time::sleep(std::time::Duration::from_secs_f64(delay + 0.25)).await;
                continue;
            }
            let page: Vec<DiscordMessage> = response.error_for_status()?.json().await?;
            if page.is_empty() { break; }
            before = page.last().map(|message| message.id.clone());
            for message in page {
                let existing: Option<Uuid> = sqlx::query_scalar(
                    "SELECT message_id FROM imported_message_sources WHERE source = $1 AND source_message_id = $2",
                ).bind(DISCORD_SOURCE).bind(&message.id).fetch_optional(pool).await?;
                let author_id = imported_author(pool, &message.author, message.member.as_ref()).await?;
                if let Err(error) = import_author_avatar(pool, config, &client, author_id, &message.author).await {
                    eprintln!("Skipping avatar for Discord user {}: {error:#}", message.author.id);
                }
                let message_id = match existing {
                    Some(message_id) => {
                        sqlx::query("UPDATE messages SET author_id = $2, content = $3, edited_at = $4 WHERE id = $1")
                            .bind(message_id).bind(author_id).bind(imported_content(&message))
                            .bind(message.edited_timestamp.as_deref().map(parse_timestamp).transpose()?)
                            .execute(pool).await?;
                        updated += 1;
                        message_id
                    }
                    None => {
                        let message_id = Uuid::new_v4();
                        sqlx::query(
                            "INSERT INTO messages (id, channel_id, author_id, content, created_at, edited_at, client_req_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
                        ).bind(message_id).bind(target_channel_id).bind(author_id).bind(imported_content(&message))
                        .bind(parse_timestamp(&message.timestamp)?).bind(message.edited_timestamp.as_deref().map(parse_timestamp).transpose()?)
                        .bind(format!("discord:{}", message.id)).execute(pool).await?;
                        sqlx::query("INSERT INTO imported_message_sources (source, source_message_id, message_id) VALUES ($1, $2, $3)")
                            .bind(DISCORD_SOURCE).bind(&message.id).bind(message_id).execute(pool).await?;
                        imported += 1;
                        message_id
                    }
                };
                for attachment in &message.attachments {
                    let already_imported: bool = sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM imported_attachment_sources WHERE source = $1 AND source_attachment_id = $2)",
                    ).bind(DISCORD_SOURCE).bind(&attachment.id).fetch_one(pool).await?;
                    if already_imported { continue; }
                    match import_attachment(pool, config, &client, message_id, author_id, attachment).await {
                        Ok(()) => attachments += 1,
                        Err(error) => eprintln!("Skipping attachment {}: {error:#}", attachment.id),
                    }
                }
                import_embed_preview(pool, config, &client, message_id, &message.embeds).await?;
            }
            // Message ids are snowflakes and Discord returns newest first.
            // A short pause avoids hammering the service between pages.
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
    }
    println!("Discord live import complete: {imported} messages inserted, {updated} updated, {attachments} attachments downloaded.");
    Ok(())
}

fn messages_from_har(har: Har) -> Result<HashMap<String, Vec<DiscordMessage>>> {
    let source_channels: std::collections::HashSet<&str> = CHANNEL_MAPPINGS.iter().map(|(id, _)| *id).collect();
    let mut result: HashMap<String, HashMap<String, DiscordMessage>> = HashMap::new();
    for entry in har.log.entries {
        if entry.request.method != "GET" { continue; }
        let Some(channel_id) = channel_id_from_url(&entry.request.url) else { continue; };
        if !source_channels.contains(channel_id.as_str()) { continue; }
        let Some(body) = entry.response.content.text else { continue; };
        let messages: Vec<DiscordMessage> = serde_json::from_str(&body).unwrap_or_default();
        for message in messages {
            result.entry(channel_id.clone()).or_default().insert(message.id.clone(), message);
        }
    }
    Ok(result.into_iter().map(|(channel, messages)| (channel, messages.into_values().collect())).collect())
}

fn channel_id_from_url(url: &str) -> Option<String> {
    let marker = "/channels/";
    let suffix = url.split_once(marker)?.1;
    let id = suffix.split('/').next()?;
    (suffix.strip_prefix(id)?.starts_with("/messages") && id.chars().all(|character| character.is_ascii_digit()))
        .then(|| id.to_string())
}

async fn imported_author(pool: &PgPool, author: &DiscordAuthor, member: Option<&DiscordMember>) -> Result<Uuid> {
    let username = format!("d_{}", author.id);
    // Discord's member nickname is deliberately preferred over global_name:
    // it is the name people actually used in the imported server.
    let display_name = member.and_then(|member| member.nick.as_deref())
        .or(author.global_name.as_deref())
        .unwrap_or(&author.username);
    let profile_tag = author.clan.as_ref().and_then(|clan| clan.tag.as_deref());
    let password_hash = auth::hash_password(&Uuid::new_v4().to_string())?;
    Ok(sqlx::query_scalar(
        "INSERT INTO users (username, display_name, password_hash, profile_tag) VALUES ($1, $2, $3, $4) \
         ON CONFLICT (username) DO UPDATE SET display_name = EXCLUDED.display_name, profile_tag = EXCLUDED.profile_tag RETURNING id",
    )
    .bind(username).bind(display_name).bind(password_hash).bind(profile_tag).fetch_one(pool).await?)
}

async fn import_author_avatar(
    pool: &PgPool,
    config: &Config,
    client: &reqwest::Client,
    user_id: Uuid,
    author: &DiscordAuthor,
) -> Result<()> {
    if let Some(hash) = author.avatar.as_deref() {
        let extension = if hash.starts_with("a_") { "gif" } else { "png" };
        let url = format!("https://cdn.discordapp.com/avatars/{}/{}.{}?size=128", author.id, hash, extension);
        let image = download_remote_image(config, client, &url, "avatar").await?;
        sqlx::query("UPDATE users SET avatar_storage_path = $2, avatar_content_type = $3 WHERE id = $1")
            .bind(user_id).bind(image.path.to_string_lossy().to_string()).bind(image.content_type)
            .execute(pool).await?;
    }
    if let Some(clan) = &author.clan {
        if let (Some(guild_id), Some(badge)) = (clan.identity_guild_id.as_deref(), clan.badge.as_deref()) {
            let badge_url = format!("https://cdn.discordapp.com/clan-badges/{guild_id}/{badge}.png?size=64");
            if let Ok(badge) = download_remote_image(config, client, &badge_url, "badge").await {
                sqlx::query("UPDATE users SET profile_badge_storage_path = $2, profile_badge_content_type = $3 WHERE id = $1")
                    .bind(user_id).bind(badge.path.to_string_lossy().to_string()).bind(badge.content_type)
                    .execute(pool).await?;
            }
        }
    }
    Ok(())
}

async fn import_attachment(
    pool: &PgPool, config: &Config, client: &reqwest::Client, message_id: Uuid, author_id: Uuid, attachment: &DiscordAttachment,
) -> Result<()> {
    let url = reqwest::Url::parse(&attachment.url).context("invalid Discord attachment URL")?;
    let Some(host) = url.host_str() else { bail!("attachment URL has no host"); };
    if !(host.ends_with("discordapp.com") || host.ends_with("discordapp.net")) {
        bail!("refusing attachment outside the Discord CDN");
    }
    let response = client.get(url).send().await?.error_for_status()?;
    let content_type = attachment.content_type.clone().or_else(|| {
        response.headers().get(CONTENT_TYPE).and_then(|value| value.to_str().ok()).map(str::to_owned)
    }).unwrap_or_else(|| "application/octet-stream".to_string());
    let bytes = response.bytes().await?;
    if bytes.is_empty() || bytes.len() > config.max_attachment_size_bytes {
        bail!("attachment {} has an unsupported size", attachment.id);
    }
    let attachment_id = Uuid::new_v4();
    let storage_path = Path::new(&config.attachment_storage_path).join(attachment_id.to_string());
    tokio::fs::write(&storage_path, &bytes).await?;
    let insert = sqlx::query(
        "INSERT INTO attachments (id, message_id, uploader_id, filename, content_type, size_bytes, storage_path) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(attachment_id).bind(message_id).bind(author_id).bind(sanitize_filename(&attachment.filename))
    .bind(content_type).bind(bytes.len() as i64).bind(storage_path.to_string_lossy().as_ref())
    .execute(pool).await;
    if let Err(error) = insert {
        let _ = tokio::fs::remove_file(&storage_path).await;
        return Err(error.into());
    }
    sqlx::query(
        "INSERT INTO imported_attachment_sources (source, source_attachment_id, attachment_id) VALUES ($1, $2, $3)",
    )
    .bind(DISCORD_SOURCE).bind(&attachment.id).bind(attachment_id).execute(pool).await?;
    Ok(())
}

fn imported_content(message: &DiscordMessage) -> String {
    let clean_content = message.content.trim();
    if clean_content.is_empty() { return "[Mensagem importada do Discord]".to_string(); }
    return clean_content.to_string();

    let mut content = message.content.trim().to_string();
    for embed in &message.embeds {
        let mut parts = Vec::new();
        if let Some(title) = &embed.title { parts.push(title.clone()); }
        if let Some(description) = &embed.description { parts.push(description.clone()); }
        if let Some(url) = &embed.url { parts.push(url.clone()); }
        if !parts.is_empty() { content.push_str(&format!("\n\n[Embed do Discord: {}]", parts.join(" — "))); }
    }
    if content.is_empty() { "[Mensagem importada do Discord]".to_string() } else { content }
}

async fn import_embed_preview(
    pool: &PgPool,
    config: &Config,
    client: &reqwest::Client,
    message_id: Uuid,
    embeds: &[DiscordEmbed],
) -> Result<()> {
    let Some(embed) = embeds.iter().find(|embed| embed.url.is_some() || embed.title.is_some()) else { return Ok(()); };
    let Some(url) = embed.url.as_deref() else { return Ok(()); };
    let image_url = embed.image.as_ref().and_then(|image| image.url.as_deref())
        .or_else(|| embed.thumbnail.as_ref().and_then(|image| image.url.as_deref()));
    let image = match image_url {
        Some(image_url) => download_remote_image(config, client, image_url, "preview").await.ok(),
        None => None,
    };
    sqlx::query(
        "INSERT INTO message_link_previews (message_id, url, title, description, site_name, image_storage_path, image_content_type) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) \
         ON CONFLICT (message_id) DO UPDATE SET url = EXCLUDED.url, title = EXCLUDED.title, description = EXCLUDED.description, \
         site_name = EXCLUDED.site_name, image_storage_path = COALESCE(EXCLUDED.image_storage_path, message_link_previews.image_storage_path), \
         image_content_type = COALESCE(EXCLUDED.image_content_type, message_link_previews.image_content_type)",
    )
    .bind(message_id).bind(url).bind(&embed.title).bind(&embed.description)
    .bind(embed.provider.as_ref().and_then(|provider| provider.name.as_deref()))
    .bind(image.as_ref().map(|image| image.path.to_string_lossy().to_string()))
    .bind(image.as_ref().map(|image| image.content_type.as_str()))
    .execute(pool).await?;
    Ok(())
}

struct DownloadedImage { path: PathBuf, content_type: String }

async fn download_remote_image(config: &Config, client: &reqwest::Client, raw_url: &str, prefix: &str) -> Result<DownloadedImage> {
    let url = reqwest::Url::parse(raw_url).context("invalid preview image URL")?;
    if url.scheme() != "https" || url.host_str().is_none_or(|host| host.eq_ignore_ascii_case("localhost")) { bail!("preview image URL must be public HTTPS"); }
    let response = client.get(url).send().await?.error_for_status()?;
    let content_type = response.headers().get(CONTENT_TYPE).and_then(|value| value.to_str().ok()).unwrap_or("application/octet-stream").to_string();
    if !content_type.starts_with("image/") { bail!("preview image is not an image"); }
    let bytes = response.bytes().await?;
    if bytes.is_empty() || bytes.len() > config.max_attachment_size_bytes { bail!("preview image has unsupported size"); }
    let path = Path::new(&config.attachment_storage_path).join(format!("{prefix}-{}", Uuid::new_v4()));
    tokio::fs::write(&path, bytes).await?;
    Ok(DownloadedImage { path, content_type })
}

fn parse_timestamp(timestamp: &str) -> Result<DateTime<Utc>> {
    Ok(DateTime::parse_from_rfc3339(timestamp)?.with_timezone(&Utc))
}

fn sanitize_filename(filename: &str) -> String {
    let cleaned: String = filename.chars().filter(|character| !matches!(character, '/' | '\\' | '\0')).collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() { "attachment".to_string() } else { trimmed.chars().take(255).collect() }
}
