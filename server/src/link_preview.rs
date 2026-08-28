use std::time::Duration;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    state::AppState,
    ws::protocol::{ChatMessagePreviewUpdated, LinkPreviewDto, OutboundEnvelope},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnfurledPreview {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub site_name: Option<String>,
    pub image_url: Option<String>,
}

/// Extracts the first http or https URL from a text string.
pub fn extract_first_url(text: &str) -> Option<String> {
    for word in text.split_whitespace() {
        let start_idx = if let Some(pos) = word.find("https://") {
            Some(pos)
        } else {
            word.find("http://")
        };
        if let Some(idx) = start_idx {
            let mut cleaned = &word[idx..];
            // Strip trailing punctuation like ), ], }, >, ., ,, ;, !, ?, ", '
            while cleaned.ends_with(')')
                || cleaned.ends_with(']')
                || cleaned.ends_with('}')
                || cleaned.ends_with('>')
                || cleaned.ends_with('.')
                || cleaned.ends_with(',')
                || cleaned.ends_with(';')
                || cleaned.ends_with('!')
                || cleaned.ends_with('?')
                || cleaned.ends_with('"')
                || cleaned.ends_with('\'')
            {
                cleaned = &cleaned[..cleaned.len() - 1];
            }
            if !cleaned.is_empty() {
                return Some(cleaned.to_string());
            }
        }
    }
    None
}

/// Spawns an async task to unfurl the first link in a chat message.
pub fn spawn_unfurl_task(
    state: AppState,
    message_id: Uuid,
    channel_id: Uuid,
    community_id: Uuid,
    content: String,
) {
    tokio::spawn(async move {
        let url_opt = extract_first_url(&content);
        if let Some(url) = url_opt {
            if let Some(preview) = fetch_link_preview(&url).await {
                // Upsert into database
                let res = sqlx::query(
                    "INSERT INTO message_link_previews (message_id, url, title, description, site_name, image_url) \
                     VALUES ($1, $2, $3, $4, $5, $6) \
                     ON CONFLICT (message_id) \
                     DO UPDATE SET url = EXCLUDED.url, title = EXCLUDED.title, description = EXCLUDED.description, \
                                   site_name = EXCLUDED.site_name, image_url = EXCLUDED.image_url",
                )
                .bind(message_id)
                .bind(&preview.url)
                .bind(&preview.title)
                .bind(&preview.description)
                .bind(&preview.site_name)
                .bind(&preview.image_url)
                .execute(&state.pool)
                .await;

                if let Err(err) = res {
                    tracing::warn!(%err, %message_id, "failed to store link preview");
                    return;
                }

                // Broadcast preview update event
                broadcast_to_community(
                    &state,
                    community_id,
                    OutboundEnvelope::new(
                        "chat.message.preview_updated",
                        ChatMessagePreviewUpdated {
                            channel_id,
                            message_id,
                            link_preview: Some(LinkPreviewDto {
                                url: preview.url,
                                title: preview.title,
                                description: preview.description,
                                site_name: preview.site_name,
                                image_url: preview.image_url,
                            }),
                        },
                    ),
                )
                .await;
            }
        } else {
            // Check if there was an existing preview to remove on edit
            let deleted = sqlx::query("DELETE FROM message_link_previews WHERE message_id = $1")
                .bind(message_id)
                .execute(&state.pool)
                .await;
            if let Ok(res) = deleted {
                if res.rows_affected() > 0 {
                    broadcast_to_community(
                        &state,
                        community_id,
                        OutboundEnvelope::new(
                            "chat.message.preview_updated",
                            ChatMessagePreviewUpdated {
                                channel_id,
                                message_id,
                                link_preview: None,
                            },
                        ),
                    )
                    .await;
                }
            }
        }
    });
}

async fn broadcast_to_community(state: &AppState, community_id: Uuid, event: OutboundEnvelope) {
    if let Ok(user_ids) = crate::db::community_member_ids(&state.pool, community_id).await {
        state.hub.broadcast_to(&user_ids, event).await;
    }
}

#[derive(Deserialize)]
struct YouTubeOEmbed {
    title: Option<String>,
    author_name: Option<String>,
    thumbnail_url: Option<String>,
}

fn extract_youtube_video_id(url_str: &str) -> Option<String> {
    if let Ok(parsed) = reqwest::Url::parse(url_str) {
        let host = parsed.host_str()?.to_lowercase();
        if host.contains("youtu.be") {
            let id = parsed.path().trim_start_matches('/').to_string();
            if !id.is_empty() {
                return Some(id.split('?').next().unwrap_or(&id).to_string());
            }
        } else if host.contains("youtube.com") {
            if parsed.path().starts_with("/shorts/") {
                let id = parsed.path().trim_start_matches("/shorts/").to_string();
                if !id.is_empty() {
                    return Some(id.split('?').next().unwrap_or(&id).to_string());
                }
            }
            if let Some((_, id)) = parsed.query_pairs().find(|(k, _)| k == "v") {
                if !id.is_empty() {
                    return Some(id.to_string());
                }
            }
        }
    }
    None
}

/// Fetches rich Open Graph / meta tag metadata for a URL.
pub async fn fetch_link_preview(target_url: &str) -> Option<UnfurledPreview> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .ok()?;

    // Check if this is a YouTube URL for dedicated rich metadata
    if let Some(video_id) = extract_youtube_video_id(target_url) {
        let oembed_url = format!(
            "https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json"
        );
        if let Ok(resp) = client.get(&oembed_url).send().await {
            if resp.status().is_success() {
                if let Ok(oembed) = resp.json::<YouTubeOEmbed>().await {
                    let thumb = oembed.thumbnail_url.or_else(|| {
                        Some(format!("https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"))
                    });
                    return Some(UnfurledPreview {
                        url: target_url.to_string(),
                        title: oembed.title.or_else(|| Some("YouTube Video".to_string())),
                        description: oembed.author_name.clone(),
                        site_name: Some("YouTube".to_string()),
                        image_url: thumb,
                    });
                }
            }
        }

        // Fallback for YouTube if oembed fails
        return Some(UnfurledPreview {
            url: target_url.to_string(),
            title: Some("YouTube Video".to_string()),
            description: None,
            site_name: Some("YouTube".to_string()),
            image_url: Some(format!("https://i.ytimg.com/vi/{video_id}/hqdefault.jpg")),
        });
    }

    let response = client
        .get(target_url)
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Twitterbot/1.0",
        )
        .header(
            reqwest::header::ACCEPT,
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/*,*/*;q=0.8",
        )
        .send()
        .await
        .ok()?;

    let final_url = response.url().to_string();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();

    // If direct image URL
    if content_type.starts_with("image/") {
        return Some(UnfurledPreview {
            url: target_url.to_string(),
            title: None,
            description: None,
            site_name: extract_domain(&final_url),
            image_url: Some(final_url),
        });
    }

    // Only parse HTML content
    if !content_type.contains("text/html") && !content_type.contains("application/xhtml") && !content_type.is_empty() {
        return None;
    }

    let body_bytes = response.bytes().await.ok()?;
    // Limit to 512 KB to avoid excessive memory on giant pages
    let max_len = body_bytes.len().min(512 * 1024);
    let html = String::from_utf8_lossy(&body_bytes[..max_len]).to_string();

    let mut title = find_meta_tag(&html, "property", "og:title")
        .or_else(|| find_meta_tag(&html, "name", "twitter:title"))
        .or_else(|| find_html_title(&html));

    let mut description = find_meta_tag(&html, "property", "og:description")
        .or_else(|| find_meta_tag(&html, "name", "twitter:description"))
        .or_else(|| find_meta_tag(&html, "name", "description"));

    let site_name = find_meta_tag(&html, "property", "og:site_name")
        .or_else(|| find_meta_tag(&html, "name", "twitter:site"))
        .or_else(|| extract_domain(&final_url));

    let mut image_url = find_meta_tag(&html, "property", "og:image")
        .or_else(|| find_meta_tag(&html, "name", "twitter:image"))
        .or_else(|| find_meta_tag(&html, "name", "twitter:image:src"));

    // Clean html entities
    title = title.map(|t| unescape_html(t.trim()));
    description = description.map(|d| unescape_html(d.trim()));

    // Resolve relative image URLs
    if let (Some(img), Ok(base)) = (image_url.as_ref(), reqwest::Url::parse(&final_url)) {
        if let Ok(resolved) = base.join(img) {
            image_url = Some(resolved.to_string());
        }
    }

    if title.is_some() || description.is_some() || image_url.is_some() {
        Some(UnfurledPreview {
            url: target_url.to_string(),
            title,
            description,
            site_name,
            image_url,
        })
    } else {
        None
    }
}

fn extract_domain(url_str: &str) -> Option<String> {
    reqwest::Url::parse(url_str)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_string()))
}

fn find_html_title(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let start_tag = "<title";
    let start_pos = lower.find(start_tag)?;
    let tag_end = html[start_pos..].find('>')? + start_pos + 1;
    let end_pos = lower[tag_end..].find("</title>")? + tag_end;
    let title = html[tag_end..end_pos].trim();
    if title.is_empty() {
        None
    } else {
        Some(title.to_string())
    }
}

fn find_meta_tag(html: &str, attr_name: &str, attr_value: &str) -> Option<String> {
    // Search case-insensitively for <meta ... attr_name="attr_value" ... content="..." ...>
    // or <meta ... content="..." ... attr_name="attr_value" ...>
    let mut cursor = 0;
    let html_lower = html.to_lowercase();

    while let Some(meta_start) = html_lower[cursor..].find("<meta") {
        let actual_meta_start = cursor + meta_start;
        let meta_end = match html[actual_meta_start..].find('>') {
            Some(end) => actual_meta_start + end + 1,
            None => break,
        };
        let tag = &html[actual_meta_start..meta_end];
        let tag_lower = &html_lower[actual_meta_start..meta_end];

        let target_match = format!("{}=\"{}\"", attr_name, attr_value);
        let target_match_single = format!("{}='{}'", attr_name, attr_value);

        if tag_lower.contains(&target_match) || tag_lower.contains(&target_match_single) {
            // Extract content attribute
            if let Some(content) = extract_attribute_value(tag, "content") {
                let cleaned = content.trim();
                if !cleaned.is_empty() {
                    return Some(cleaned.to_string());
                }
            }
        }

        cursor = meta_end;
    }
    None
}

fn extract_attribute_value<'a>(tag: &'a str, attr: &str) -> Option<&'a str> {
    let tag_lower = tag.to_lowercase();
    let pattern_double = format!("{}=\"", attr);
    if let Some(idx) = tag_lower.find(&pattern_double) {
        let val_start = idx + pattern_double.len();
        if let Some(val_end) = tag[val_start..].find('"') {
            return Some(&tag[val_start..val_start + val_end]);
        }
    }
    let pattern_single = format!("{}='", attr);
    if let Some(idx) = tag_lower.find(&pattern_single) {
        let val_start = idx + pattern_single.len();
        if let Some(val_end) = tag[val_start..].find('\'') {
            return Some(&tag[val_start..val_start + val_end]);
        }
    }
    None
}

fn unescape_html(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&#x27;", "'")
        .replace("&#x2F;", "/")
        .replace("&nbsp;", " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_first_url() {
        assert_eq!(
            extract_first_url("check this: https://youtu.be/cnrPq7ZaIRo?si=123 cool"),
            Some("https://youtu.be/cnrPq7ZaIRo?si=123".to_string())
        );
        assert_eq!(
            extract_first_url("look at (https://github.com/rust-lang/rust)"),
            Some("https://github.com/rust-lang/rust".to_string())
        );
        assert_eq!(
            extract_first_url("no links here at all"),
            None
        );
    }

    #[test]
    fn test_extract_youtube_video_id() {
        assert_eq!(
            extract_youtube_video_id("https://youtu.be/cnrPq7ZaIRo?si=37FUQTHo5x5Xo9fM"),
            Some("cnrPq7ZaIRo".to_string())
        );
        assert_eq!(
            extract_youtube_video_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
            Some("dQw4w9WgXcQ".to_string())
        );
        assert_eq!(
            extract_youtube_video_id("https://www.youtube.com/shorts/abc12345"),
            Some("abc12345".to_string())
        );
    }
}
