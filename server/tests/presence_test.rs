mod common;

use std::time::Duration;

use common::{TestApp, WsClient};

#[tokio::test]
async fn a_newly_connected_client_sees_who_is_already_online() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let (member_token, member_id) = app.register_member(bootstrap.community_id, "presence_watcher").await;

    let _owner_ws = WsClient::connect_and_authenticate(&app.ws_url, &bootstrap.owner_token).await;
    let mut member_ws = WsClient::connect_and_authenticate(&app.ws_url, &member_token).await;

    let snapshot = member_ws.recv_op("presence.snapshot").await.expect("expected a presence snapshot on connect");
    let users = snapshot["users"].as_array().unwrap();
    let owner_entry = users.iter().find(|u| u["user_id"] == bootstrap.owner_id.to_string());
    assert_eq!(
        owner_entry.map(|u| u["status"].as_str()),
        Some(Some("online")),
        "the owner, who connected first, must already show as online in the new client's snapshot"
    );
    let _ = member_id;

    app.teardown().await;
}

#[tokio::test]
async fn disconnecting_marks_the_user_offline_only_after_the_grace_period() {
    let app = TestApp::spawn_with_offline_grace(8).await;
    let bootstrap = app.bootstrap().await;
    let (member_token, member_id) = app.register_member(bootstrap.community_id, "flaky_connection").await;

    let mut owner_ws = WsClient::connect_and_authenticate(&app.ws_url, &bootstrap.owner_token).await;
    let member_ws = WsClient::connect_and_authenticate(&app.ws_url, &member_token).await;
    owner_ws
        .recv_presence_update_for(member_id, Duration::from_secs(3))
        .await
        .expect("owner should be told the member came online");

    member_ws.close().await;

    // PRES-FR (grace period): must NOT flip to offline immediately.
    let immediate = owner_ws.recv_presence_update_for(member_id, Duration::from_secs(2)).await;
    assert!(
        immediate.is_none(),
        "a disconnect must not immediately broadcast offline (8s grace period), got: {immediate:?}"
    );

    // ...but must flip to offline once the grace period actually elapses.
    let eventually = owner_ws
        .recv_presence_update_for(member_id, Duration::from_secs(9))
        .await
        .expect("presence must go offline once the grace period elapses");
    assert_eq!(eventually["status"], "offline");

    app.teardown().await;
}

#[tokio::test]
async fn reconnecting_within_the_grace_period_cancels_the_offline_transition() {
    let app = TestApp::spawn_with_offline_grace(8).await;
    let bootstrap = app.bootstrap().await;
    let (member_token, member_id) = app.register_member(bootstrap.community_id, "quick_reconnector").await;

    let mut owner_ws = WsClient::connect_and_authenticate(&app.ws_url, &bootstrap.owner_token).await;
    let member_ws = WsClient::connect_and_authenticate(&app.ws_url, &member_token).await;
    owner_ws.recv_presence_update_for(member_id, Duration::from_secs(3)).await.unwrap();

    member_ws.close().await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let _reconnected_member_ws = WsClient::connect_and_authenticate(&app.ws_url, &member_token).await;

    // No further presence.update for this user_id must ever be broadcast
    // across the whole grace window (neither "offline", since the member
    // came back before the grace period elapsed, nor a redundant "online"
    // — the server already knows related clients still think it's online).
    let should_not_arrive = owner_ws.recv_presence_update_for(member_id, Duration::from_secs(9)).await;
    assert!(
        should_not_arrive.is_none(),
        "PRES-FR: a reconnect inside the grace period must cancel the pending offline broadcast entirely, \
         got: {should_not_arrive:?}"
    );

    app.teardown().await;
}
