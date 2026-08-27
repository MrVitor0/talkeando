mod common;

use common::{TestApp, WsClient};

#[tokio::test]
async fn joining_a_call_returns_a_snapshot_and_notifies_existing_participants() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let (member_token, member_id) = app.register_member(bootstrap.community_id, "voice_joiner").await;

    let mut owner_ws = WsClient::connect_and_authenticate(&app.ws_url, &bootstrap.owner_token).await;
    owner_ws
        .send("call.join", serde_json::json!({ "channel_id": bootstrap.voice_channel_id }))
        .await;
    let owner_snapshot = owner_ws.recv_op("call.snapshot").await.expect("owner should get a snapshot");
    assert_eq!(owner_snapshot["participants"].as_array().unwrap().len(), 1);

    let mut member_ws = WsClient::connect_and_authenticate(&app.ws_url, &member_token).await;
    member_ws
        .send("call.join", serde_json::json!({ "channel_id": bootstrap.voice_channel_id }))
        .await;
    let member_snapshot = member_ws.recv_op("call.snapshot").await.expect("member should get a snapshot");
    assert_eq!(
        member_snapshot["participants"].as_array().unwrap().len(),
        2,
        "the member's own snapshot must already include the owner who joined earlier"
    );

    let peer_joined = owner_ws
        .recv_op("call.peer_joined")
        .await
        .expect("CALL-FR: existing participants must be notified when someone new joins");
    assert_eq!(peer_joined["participant"]["user_id"], member_id.to_string());

    app.teardown().await;
}

#[tokio::test]
async fn rtc_signaling_cannot_target_a_peer_outside_the_same_call() {
    // RTC-FR / SEC-NFR: "impedir usuário de sinalizar peer fora da call".
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let (member_token, member_id) = app.register_member(bootstrap.community_id, "bystander").await;

    let mut owner_ws = WsClient::connect_and_authenticate(&app.ws_url, &bootstrap.owner_token).await;
    owner_ws
        .send("call.join", serde_json::json!({ "channel_id": bootstrap.voice_channel_id }))
        .await;
    owner_ws.recv_op("call.snapshot").await.unwrap();

    // The member is authenticated and online, but never joined the call —
    // sending them an rtc.offer must be rejected, not silently relayed.
    let mut member_ws = WsClient::connect_and_authenticate(&app.ws_url, &member_token).await;

    owner_ws
        .send(
            "rtc.offer",
            serde_json::json!({ "channel_id": bootstrap.voice_channel_id, "to": member_id, "sdp": "v=0\r\n..." }),
        )
        .await;

    let error = owner_ws.recv_op("error").await.expect("expected a rejection, not a silent drop");
    assert_eq!(error["code"], "forbidden");

    // The bystander must never actually receive the offer.
    let leaked = member_ws.recv_op("rtc.offer").await;
    assert!(leaked.is_none(), "rtc.offer must never reach a user outside the call");

    app.teardown().await;
}

#[tokio::test]
async fn a_published_stream_sends_no_media_until_a_subscribe_arrives() {
    // SUB-FR-001, the single most load-bearing invariant in this project:
    // 0 subscribers <=> 0 bytes. This test exercises the *signaling* half —
    // that the owner is only told to start sending after a real
    // stream.subscribe from a call participant, and never before.
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let (viewer_token, viewer_id) = app.register_member(bootstrap.community_id, "viewer").await;

    let mut owner_ws = WsClient::connect_and_authenticate(&app.ws_url, &bootstrap.owner_token).await;
    owner_ws
        .send("call.join", serde_json::json!({ "channel_id": bootstrap.voice_channel_id }))
        .await;
    owner_ws.recv_op("call.snapshot").await.unwrap();

    let mut viewer_ws = WsClient::connect_and_authenticate(&app.ws_url, &viewer_token).await;
    viewer_ws
        .send("call.join", serde_json::json!({ "channel_id": bootstrap.voice_channel_id }))
        .await;
    viewer_ws.recv_op("call.snapshot").await.unwrap();
    owner_ws.recv_op("call.peer_joined").await.unwrap();

    let stream_id = uuid::Uuid::new_v4();
    owner_ws
        .send(
            "stream.publish",
            serde_json::json!({
                "channel_id": bootstrap.voice_channel_id, "stream_id": stream_id, "kind": "screen", "has_audio": false,
            }),
        )
        .await;
    owner_ws.recv_op("stream.published").await.expect("owner sees its own publish confirmed");
    viewer_ws.recv_op("stream.published").await.expect("other call participants are told a stream exists");

    // Critical: publishing alone must NOT tell the owner to send anything.
    let premature = owner_ws.recv_op("stream.subscription_requested").await;
    assert!(premature.is_none(), "SUB-FR-001: publish must never itself trigger a send");

    viewer_ws
        .send(
            "stream.subscribe",
            serde_json::json!({ "channel_id": bootstrap.voice_channel_id, "stream_id": stream_id }),
        )
        .await;
    let requested = owner_ws
        .recv_op("stream.subscription_requested")
        .await
        .expect("only now, after an explicit subscribe, must the owner be told to start sending");
    assert_eq!(requested["subscriber"], viewer_id.to_string());
    assert_eq!(requested["stream_id"], stream_id.to_string());

    viewer_ws
        .send(
            "stream.unsubscribe",
            serde_json::json!({ "channel_id": bootstrap.voice_channel_id, "stream_id": stream_id }),
        )
        .await;
    let unsubscribed = owner_ws
        .recv_op("stream.unsubscribed")
        .await
        .expect("owner must be told to stop sending on unsubscribe");
    assert_eq!(unsubscribed["subscriber"], viewer_id.to_string());

    app.teardown().await;
}

#[tokio::test]
async fn leaving_a_call_tears_down_streams_the_leaver_owned() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let (viewer_token, _viewer_id) = app.register_member(bootstrap.community_id, "watcher").await;

    let mut owner_ws = WsClient::connect_and_authenticate(&app.ws_url, &bootstrap.owner_token).await;
    owner_ws
        .send("call.join", serde_json::json!({ "channel_id": bootstrap.voice_channel_id }))
        .await;
    owner_ws.recv_op("call.snapshot").await.unwrap();

    let mut viewer_ws = WsClient::connect_and_authenticate(&app.ws_url, &viewer_token).await;
    viewer_ws
        .send("call.join", serde_json::json!({ "channel_id": bootstrap.voice_channel_id }))
        .await;
    viewer_ws.recv_op("call.snapshot").await.unwrap();
    owner_ws.recv_op("call.peer_joined").await.unwrap();

    let stream_id = uuid::Uuid::new_v4();
    owner_ws
        .send(
            "stream.publish",
            serde_json::json!({ "channel_id": bootstrap.voice_channel_id, "stream_id": stream_id, "kind": "screen", "has_audio": false }),
        )
        .await;
    owner_ws.recv_op("stream.published").await.unwrap();
    viewer_ws.recv_op("stream.published").await.unwrap();

    owner_ws
        .send("call.leave", serde_json::json!({ "channel_id": bootstrap.voice_channel_id }))
        .await;

    let unpublished = viewer_ws
        .recv_op("stream.unpublished")
        .await
        .expect("a departed publisher's stream must be torn down for remaining participants");
    assert_eq!(unpublished["stream_id"], stream_id.to_string());

    app.teardown().await;
}
