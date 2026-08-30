//! Step 2 of the Discord HAR import: `discord_import::import_json` reads the
//! reviewed JSON produced by `scripts/discord-import/har-to-json.mjs` and turns
//! it into ordinary Talkeando messages / link previews / rich embeds. This test
//! covers the offline path (no CDN download): text, a pure link with an unfurl,
//! and a content-less bot embed with fields — plus a re-run to prove the import
//! is idempotent through the `imported_message_sources` ledger.

mod common;

use common::TestApp;
use tupi_server::config::Config;
use uuid::Uuid;

fn test_config(attachment_storage_path: String) -> Config {
    Config {
        database_url: "postgres://unused".to_string(),
        bind_addr: "127.0.0.1:0".to_string(),
        session_ttl_days: 30,
        turn_shared_secret: "x".to_string(),
        turn_realm: "test.local".to_string(),
        turn_uris: vec!["turn:localhost:3478".to_string()],
        turn_credential_ttl_seconds: 3600,
        max_attachment_size_bytes: 25 * 1024 * 1024,
        attachment_storage_path,
        allowed_origins: vec!["http://localhost:5173".to_string()],
        unattached_attachment_ttl_hours: 24,
        music_bot_token: "test-music-bot-token".to_string(),
        livekit_url: Some("ws://localhost:7880".to_string()),
        livekit_api_key: Some("APItestkey".to_string()),
        livekit_api_secret: Some("test-livekit-secret".to_string()),
        livekit_token_ttl_seconds: 21_600,
    }
}

fn fixture_json() -> String {
    serde_json::json!({
        "source": "discord.com.har",
        "users": [{
            "id": "u-1",
            "discord_id": "331581430109044747",
            "username": "d_331581430109044747",
            "display_name": "Vitor",
            "avatar_url": null,
            "profile_tag": null
        }],
        "messages": [
            {
                "id": "11111111-1111-5111-8111-111111111111",
                "discord_id": "1000000000000000001",
                "channel_name": "átrio-principal",
                "author_id": "u-1",
                "kind": "text",
                "content": "primeira mensagem importada",
                "created_at": "2025-01-01T10:00:00.000000+00:00",
                "edited_at": null,
                "attachments": [],
                "link_preview": null,
                "embeds": []
            },
            {
                "id": "22222222-2222-5222-8222-222222222222",
                "discord_id": "1000000000000000002",
                "channel_name": "átrio-principal",
                "author_id": "u-1",
                "kind": "link",
                "content": "https://youtu.be/Ug3uxKkSd-w",
                "created_at": "2025-01-01T10:05:00.000000+00:00",
                "edited_at": null,
                "attachments": [],
                "link_preview": {
                    "url": "https://youtu.be/Ug3uxKkSd-w",
                    "title": "remaking VIRAL songs with my voice",
                    "description": "try audimee for free",
                    "site_name": "YouTube",
                    "image_source_url": null
                },
                "embeds": []
            },
            {
                "id": "33333333-3333-5333-8333-333333333333",
                "discord_id": "1000000000000000003",
                "channel_name": "átrio-principal",
                "author_id": "u-1",
                "kind": "embed",
                "content": "",
                "created_at": "2025-01-01T10:10:00.000000+00:00",
                "edited_at": null,
                "attachments": [],
                "link_preview": null,
                "embeds": [{
                    "position": 0,
                    "title": "The Battle of Polytopia",
                    "description": "turn-based strategy",
                    "url": "https://store.steampowered.com/app/874390/",
                    "color": 1942002,
                    "author_name": null,
                    "author_url": null,
                    "provider_name": "Steam",
                    "footer_text": "Steam",
                    "footer_icon_source_url": null,
                    "image_source_url": null,
                    "thumbnail_source_url": null,
                    "fields": [
                        { "name": "Price", "value": "$14.99", "inline": true },
                        { "name": "Metacritic", "value": "72", "inline": true }
                    ]
                }]
            }
        ]
    })
    .to_string()
}

#[tokio::test]
async fn import_json_inserts_history_and_is_idempotent() {
    let app = TestApp::spawn().await;
    let b = app.bootstrap().await;

    // The importer maps by channel name; bootstrap only makes `#general`.
    let channel_id: Uuid = sqlx::query_scalar(
        "INSERT INTO channels (community_id, name, kind, position) VALUES ($1, 'átrio-principal', 'text', 5) RETURNING id",
    )
    .bind(b.community_id)
    .fetch_one(&app.pool)
    .await
    .unwrap();

    let attachment_dir = std::env::temp_dir().join(format!("discord-import-test-{}", Uuid::new_v4().simple()));
    tokio::fs::create_dir_all(&attachment_dir).await.unwrap();
    let config = test_config(attachment_dir.to_string_lossy().to_string());

    let json_path = attachment_dir.join("import.json");
    tokio::fs::write(&json_path, fixture_json()).await.unwrap();

    tupi_server::discord_import::import_json(&app.pool, &config, &json_path)
        .await
        .expect("first import_json run");

    // 3 messages, all attributed to the imported author with the global name.
    let msg_count: i64 = sqlx::query_scalar("SELECT count(*) FROM messages WHERE channel_id = $1")
        .bind(channel_id)
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(msg_count, 3);

    let (author_name, author_username): (String, String) = sqlx::query_as(
        "SELECT u.display_name, u.username FROM messages m JOIN users u ON u.id = m.author_id \
         WHERE m.client_req_id = 'discord:1000000000000000001'",
    )
    .fetch_one(&app.pool)
    .await
    .unwrap();
    assert_eq!(author_name, "Vitor");
    assert_eq!(author_username, "d_331581430109044747");

    let ledger_count: i64 = sqlx::query_scalar("SELECT count(*) FROM imported_message_sources")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(ledger_count, 3);

    // The pure-link message got a link preview from its unfurl.
    let (preview_url, preview_title): (String, Option<String>) = sqlx::query_as(
        "SELECT p.url, p.title FROM message_link_previews p JOIN messages m ON m.id = p.message_id \
         WHERE m.client_req_id = 'discord:1000000000000000002'",
    )
    .fetch_one(&app.pool)
    .await
    .unwrap();
    assert_eq!(preview_url, "https://youtu.be/Ug3uxKkSd-w");
    assert_eq!(preview_title.as_deref(), Some("remaking VIRAL songs with my voice"));

    // The content-less bot message got a rich embed with its fields intact.
    let (embed_title, embed_color, embed_fields): (Option<String>, Option<i32>, serde_json::Value) = sqlx::query_as(
        "SELECT e.title, e.color, e.fields FROM message_embeds e JOIN messages m ON m.id = e.message_id \
         WHERE m.client_req_id = 'discord:1000000000000000003'",
    )
    .fetch_one(&app.pool)
    .await
    .unwrap();
    assert_eq!(embed_title.as_deref(), Some("The Battle of Polytopia"));
    assert_eq!(embed_color, Some(1942002));
    assert_eq!(embed_fields.as_array().map(|a| a.len()), Some(2));
    assert_eq!(embed_fields[0]["name"], "Price");

    // History endpoint surfaces the embed to the client.
    let (member_token, _member_id) = app.register_member(b.community_id, "reader").await;
    let client = reqwest::Client::new();
    let history: serde_json::Value = client
        .get(format!("{}/channels/{}/messages", app.http_url, channel_id))
        .bearer_auth(&member_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let messages = history["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 3);
    let embed_msg = messages
        .iter()
        .find(|m| m["content"] == "")
        .expect("content-less embed message in history");
    assert_eq!(embed_msg["embeds"][0]["title"], "The Battle of Polytopia");
    assert_eq!(embed_msg["embeds"][0]["fields"][1]["value"], "72");

    // Re-running must not duplicate anything.
    tupi_server::discord_import::import_json(&app.pool, &config, &json_path)
        .await
        .expect("second import_json run");
    let msg_count_after: i64 = sqlx::query_scalar("SELECT count(*) FROM messages WHERE channel_id = $1")
        .bind(channel_id)
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(msg_count_after, 3, "re-import must be idempotent");
    let embed_count_after: i64 = sqlx::query_scalar("SELECT count(*) FROM message_embeds")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(embed_count_after, 1, "embeds replaced, not appended, on re-import");

    tokio::fs::remove_dir_all(&attachment_dir).await.ok();
    app.teardown().await;
}
