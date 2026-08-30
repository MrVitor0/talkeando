mod common;

use common::{TestApp, WsClient};

const MUSIC_BOT_ID: &str = "00000000-0000-0000-0000-000000000001";

#[tokio::test]
async fn music_status_is_persisted_and_broadcast_as_a_message() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;

    let mut owner_ws = WsClient::connect_and_authenticate(&app.ws_url, &bootstrap.owner_token).await;
    let mut bot_ws = WsClient::connect_and_authenticate(&app.ws_url, "test-music-bot-token").await;

    bot_ws
        .send(
            "music.status",
            serde_json::json!({
                "status_id": uuid::Uuid::new_v4(),
                "channel_id": bootstrap.text_channel_id,
                "kind": "playing",
                "origin": "spotify",
                "title": "Song X",
                "artist": "Artist Y",
            }),
        )
        .await;

    // The card reaches every community member as an ordinary chat message.
    let created = owner_ws
        .recv_op("chat.message.created")
        .await
        .expect("the music bot's status card must be broadcast as a chat message");
    let message = &created["message"];
    assert_eq!(message["author_id"], MUSIC_BOT_ID);
    assert_eq!(message["content"], "", "the card renders from music_status, not body text");
    assert_eq!(message["music_status"]["kind"], "playing");
    assert_eq!(message["music_status"]["title"], "Song X");
    assert_eq!(message["music_status"]["origin"], "spotify");

    // …and it is persisted: a later history load returns it with the bot as
    // a real author.
    let client = reqwest::Client::new();
    let history = client
        .get(format!("{}/channels/{}/messages", app.http_url, bootstrap.text_channel_id))
        .bearer_auth(&bootstrap.owner_token)
        .send()
        .await
        .unwrap();
    assert_eq!(history.status(), 200);
    let history: serde_json::Value = history.json().await.unwrap();
    let persisted = &history["messages"][0];
    assert_eq!(persisted["music_status"]["kind"], "playing");
    assert_eq!(persisted["music_status"]["title"], "Song X");
    assert_eq!(persisted["author"]["display_name"], "Tupi Música");
    assert_eq!(persisted["author"]["profile_tag"], "BOT");
    assert_eq!(persisted["content"], "");

    app.teardown().await;
}

#[tokio::test]
async fn a_human_cannot_publish_a_music_status() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;

    let mut owner_ws = WsClient::connect_and_authenticate(&app.ws_url, &bootstrap.owner_token).await;
    owner_ws
        .send(
            "music.status",
            serde_json::json!({
                "status_id": uuid::Uuid::new_v4(),
                "channel_id": bootstrap.text_channel_id,
                "kind": "playing",
            }),
        )
        .await;

    let error = owner_ws.recv_op("error").await.expect("a non-bot music.status must be rejected");
    assert_eq!(error["code"], "forbidden");

    app.teardown().await;
}
