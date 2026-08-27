mod common;

use common::{TestApp, WsClient};

#[tokio::test]
async fn an_uploaded_attachment_becomes_visible_in_history_once_attached_to_a_message() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let (member_token, _member_id) = app.register_member(bootstrap.community_id, "reader").await;

    let client = reqwest::Client::new();
    let form = reqwest::multipart::Form::new().part(
        "file",
        reqwest::multipart::Part::bytes(b"hello attachment".to_vec())
            .file_name("note.txt")
            .mime_str("text/plain")
            .unwrap(),
    );
    let upload = client
        .post(format!("{}/channels/{}/attachments", app.http_url, bootstrap.text_channel_id))
        .bearer_auth(&bootstrap.owner_token)
        .multipart(form)
        .send()
        .await
        .unwrap();
    assert_eq!(upload.status(), 201, "ATTACH-FR: a valid, allowlisted upload must succeed");
    let uploaded: serde_json::Value = upload.json().await.unwrap();
    let attachment_id = uploaded["id"].as_str().unwrap().to_string();

    let mut owner_ws = WsClient::connect_and_authenticate(&app.ws_url, &bootstrap.owner_token).await;
    owner_ws
        .send(
            "chat.message.create",
            serde_json::json!({
                "channel_id": bootstrap.text_channel_id,
                "content": "see attached",
                "req_id": "55555555-5555-5555-5555-555555555555",
                "attachment_ids": [attachment_id],
            }),
        )
        .await;
    let created = owner_ws.recv_op("chat.message.created").await.unwrap();
    assert_eq!(created["message"]["attachment_ids"][0], attachment_id);

    // History (fetched as a *different* community member, not the
    // uploader) must show the attachment's metadata, not just its id.
    let client = reqwest::Client::new();
    let history = client
        .get(format!("{}/channels/{}/messages", app.http_url, bootstrap.text_channel_id))
        .bearer_auth(&member_token)
        .send()
        .await
        .unwrap();
    assert_eq!(history.status(), 200);
    let history: serde_json::Value = history.json().await.unwrap();
    let attachments = &history["messages"][0]["attachments"];
    assert_eq!(attachments[0]["id"], attachment_id);
    assert_eq!(attachments[0]["filename"], "note.txt");

    // Any community member (not just the uploader) can download it.
    let download = client
        .get(format!("{}/attachments/{}", app.http_url, attachment_id))
        .bearer_auth(&member_token)
        .send()
        .await
        .unwrap();
    assert_eq!(download.status(), 200);
    assert_eq!(download.bytes().await.unwrap().as_ref(), b"hello attachment");

    app.teardown().await;
}

#[tokio::test]
async fn upload_rejects_a_disallowed_content_type() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;

    let client = reqwest::Client::new();
    let form = reqwest::multipart::Form::new().part(
        "file",
        reqwest::multipart::Part::bytes(b"#!/bin/sh\necho hi".to_vec())
            .file_name("script.sh")
            .mime_str("application/x-sh")
            .unwrap(),
    );
    let upload = client
        .post(format!("{}/channels/{}/attachments", app.http_url, bootstrap.text_channel_id))
        .bearer_auth(&bootstrap.owner_token)
        .multipart(form)
        .send()
        .await
        .unwrap();
    assert_eq!(upload.status(), 400, "ATTACH-FR: only allowlisted content types may be uploaded");

    app.teardown().await;
}

#[tokio::test]
async fn a_user_outside_the_community_cannot_download_an_attachment() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;

    let client = reqwest::Client::new();
    let form = reqwest::multipart::Form::new().part(
        "file",
        reqwest::multipart::Part::bytes(b"private".to_vec())
            .file_name("private.txt")
            .mime_str("text/plain")
            .unwrap(),
    );
    let upload = client
        .post(format!("{}/channels/{}/attachments", app.http_url, bootstrap.text_channel_id))
        .bearer_auth(&bootstrap.owner_token)
        .multipart(form)
        .send()
        .await
        .unwrap();
    let uploaded: serde_json::Value = upload.json().await.unwrap();
    let attachment_id = uploaded["id"].as_str().unwrap().to_string();

    // A second, unrelated community + user who never joined this one.
    let other_community: (uuid::Uuid,) = sqlx::query_as("INSERT INTO communities (name) VALUES ('Other') RETURNING id")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    let outsider_token = {
        let password_hash = talkeando_server::auth::hash_password("outsider-pass-123").unwrap();
        let outsider_id: (uuid::Uuid,) = sqlx::query_as(
            "INSERT INTO users (username, display_name, password_hash) VALUES ('outsider', 'Outsider', $1) RETURNING id",
        )
        .bind(&password_hash)
        .fetch_one(&app.pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO community_members (community_id, user_id, role) VALUES ($1, $2, 'member')")
            .bind(other_community.0)
            .bind(outsider_id.0)
            .execute(&app.pool)
            .await
            .unwrap();
        app.login("outsider", "outsider-pass-123").await
    };

    let download = client
        .get(format!("{}/attachments/{}", app.http_url, attachment_id))
        .bearer_auth(&outsider_token)
        .send()
        .await
        .unwrap();
    assert_eq!(
        download.status(),
        404,
        "must look identical to a nonexistent attachment — never reveal that it exists to a non-member"
    );

    app.teardown().await;
}
