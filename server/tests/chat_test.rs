mod common;

use common::{TestApp, WsClient};

#[tokio::test]
async fn sending_a_message_twice_with_the_same_req_id_never_duplicates_it() {
    // Automates the manual runtime check performed for ADR-004
    // (SDD/27-decisions.md) — a client-side send timeout must be safe to
    // retry even if the original attempt actually succeeded.
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let mut client = WsClient::connect_and_authenticate(&app.ws_url, &bootstrap.owner_token).await;

    let req_id = "11111111-1111-1111-1111-111111111111";
    let payload = serde_json::json!({
        "channel_id": bootstrap.text_channel_id,
        "content": "hello twice",
        "req_id": req_id,
        "attachment_ids": [],
    });

    client.send("chat.message.create", payload.clone()).await;
    let first = client.recv_op("chat.message.created").await.expect("first confirmation");
    assert_eq!(first["in_reply_to"], req_id);
    let message_id = first["message"]["id"].clone();

    client.send("chat.message.create", payload).await;
    let second = client.recv_op("chat.message.created").await.expect("retry confirmation");
    assert_eq!(second["message"]["id"], message_id, "retry must resolve to the same message, not create a new one");
    assert_eq!(second["message"]["content"], first["message"]["content"]);

    let row_count: (i64,) = sqlx::query_as("SELECT count(*) FROM messages WHERE client_req_id = $1")
        .bind(req_id)
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(row_count.0, 1, "exactly one row must exist in the database, not two");

    app.teardown().await;
}

#[tokio::test]
async fn a_user_cannot_send_messages_to_a_channel_outside_their_community() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;

    // A second, unrelated community + channel the test user is not a member of.
    let other_channel_id: (uuid::Uuid,) = {
        let other_community: (uuid::Uuid,) = sqlx::query_as("INSERT INTO communities (name) VALUES ('Other') RETURNING id")
            .fetch_one(&app.pool)
            .await
            .unwrap();
        sqlx::query_as(
            "INSERT INTO channels (community_id, name, kind, position) VALUES ($1, 'secret', 'text', 0) RETURNING id",
        )
        .bind(other_community.0)
        .fetch_one(&app.pool)
        .await
        .unwrap()
    };

    let mut client = WsClient::connect_and_authenticate(&app.ws_url, &bootstrap.owner_token).await;
    client
        .send(
            "chat.message.create",
            serde_json::json!({
                "channel_id": other_channel_id.0,
                "content": "should not be allowed",
                "req_id": "22222222-2222-2222-2222-222222222222",
                "attachment_ids": [],
            }),
        )
        .await;

    let error = client.recv_op("error").await.expect("expected an error envelope");
    assert_eq!(error["code"], "forbidden");

    let row_count: (i64,) = sqlx::query_as("SELECT count(*) FROM messages WHERE channel_id = $1")
        .bind(other_channel_id.0)
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(row_count.0, 0, "the message must never be persisted");

    app.teardown().await;
}

#[tokio::test]
async fn editing_and_deleting_a_message_is_broadcast_to_other_connected_clients() {
    // The author's own client applies an edit/delete optimistically in the
    // UI — the broadcast matters for *everyone else* watching the channel.
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let (member_token, _member_id) = app.register_member(bootstrap.community_id, "silent_reader").await;

    let mut owner_ws = WsClient::connect_and_authenticate(&app.ws_url, &bootstrap.owner_token).await;
    let mut member_ws = WsClient::connect_and_authenticate(&app.ws_url, &member_token).await;

    owner_ws
        .send(
            "chat.message.create",
            serde_json::json!({
                "channel_id": bootstrap.text_channel_id, "content": "original", "req_id": "66666666-6666-6666-6666-666666666666", "attachment_ids": [],
            }),
        )
        .await;
    let created = owner_ws.recv_op("chat.message.created").await.unwrap();
    member_ws.recv_op("chat.message.created").await.expect("the other client must see the new message too");
    let message_id = created["message"]["id"].as_str().unwrap().to_string();

    owner_ws
        .send(
            "chat.message.edit",
            serde_json::json!({ "message_id": message_id, "content": "edited", "req_id": "77777777-7777-7777-7777-777777777777" }),
        )
        .await;
    let edited_for_member = member_ws
        .recv_op("chat.message.edited")
        .await
        .expect("CHAT-FR: an edit must be broadcast to every other connected client, not just echoed to the author");
    assert_eq!(edited_for_member["message_id"], message_id);
    assert_eq!(edited_for_member["content"], "edited");

    owner_ws
        .send(
            "chat.message.delete",
            serde_json::json!({ "message_id": message_id, "req_id": "88888888-8888-8888-8888-888888888888" }),
        )
        .await;
    let deleted_for_member = member_ws
        .recv_op("chat.message.deleted")
        .await
        .expect("CHAT-FR: a delete must be broadcast to every other connected client, not just echoed to the author");
    assert_eq!(deleted_for_member["message_id"], message_id);

    app.teardown().await;
}

#[tokio::test]
async fn only_the_author_can_edit_or_delete_their_own_message() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let (member_token, _member_id) = app.register_member(bootstrap.community_id, "editor_victim").await;

    let mut owner_ws = WsClient::connect_and_authenticate(&app.ws_url, &bootstrap.owner_token).await;
    owner_ws
        .send(
            "chat.message.create",
            serde_json::json!({
                "channel_id": bootstrap.text_channel_id,
                "content": "owner's message",
                "req_id": "33333333-3333-3333-3333-333333333333",
                "attachment_ids": [],
            }),
        )
        .await;
    let created = owner_ws.recv_op("chat.message.created").await.unwrap();
    let message_id = created["message"]["id"].as_str().unwrap().to_string();

    let mut member_ws = WsClient::connect_and_authenticate(&app.ws_url, &member_token).await;
    member_ws
        .send(
            "chat.message.edit",
            serde_json::json!({ "message_id": message_id, "content": "hijacked", "req_id": "44444444-4444-4444-4444-444444444444" }),
        )
        .await;
    let edit_error = member_ws.recv_op("error").await.expect("editing someone else's message must error");
    assert_eq!(edit_error["code"], "forbidden");

    let content: (String,) = sqlx::query_as("SELECT content FROM messages WHERE id = $1::uuid")
        .bind(&message_id)
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(content.0, "owner's message", "content must be unchanged after the rejected edit");

    app.teardown().await;
}
