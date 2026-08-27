mod common;

use std::time::Duration;

use common::{TestApp, WsClient};

fn listening(name: &str, track: &str) -> serde_json::Value {
    serde_json::json!({
        "kind": "listening",
        "name": name,
        "details": track,
        "state": "Some Artist",
        "started_at": "2026-08-27T21:03:00Z"
    })
}

/// ACT-FR-004: a valid activity.report is broadcast to the reporter's
/// community.
#[tokio::test]
async fn activity_report_reaches_other_members() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let (member_token, member_id) = app.register_member(bootstrap.community_id, "dj_member").await;

    let mut owner_ws = WsClient::connect_and_authenticate(&app.ws_url, &bootstrap.owner_token).await;
    let mut member_ws = WsClient::connect_and_authenticate(&app.ws_url, &member_token).await;

    member_ws
        .send("activity.report", serde_json::json!({ "activities": [listening("Spotify", "Track One")] }))
        .await;

    let update = owner_ws
        .recv_op_timeout("activity.update", Duration::from_secs(3))
        .await
        .expect("owner should receive activity.update for the member");
    assert_eq!(update["user_id"], member_id.to_string());
    assert_eq!(update["activities"][0]["name"], "Spotify");
    assert_eq!(update["activities"][0]["details"], "Track One");

    app.teardown().await;
}

/// ACT-FR-005 / ACT-FR-013: a freshly connected client is handed an
/// activity.snapshot of everyone who currently has activity.
#[tokio::test]
async fn new_connection_receives_activity_snapshot() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let (member_token, member_id) = app.register_member(bootstrap.community_id, "snapshot_dj").await;

    let mut member_ws = WsClient::connect_and_authenticate(&app.ws_url, &member_token).await;
    member_ws
        .send("activity.report", serde_json::json!({ "activities": [listening("Spotify", "Persisted")] }))
        .await;
    // Let the server apply the report before the watcher connects.
    tokio::time::sleep(Duration::from_millis(300)).await;

    let mut watcher_ws = WsClient::connect_and_authenticate(&app.ws_url, &bootstrap.owner_token).await;
    let snapshot = watcher_ws
        .recv_op_timeout("activity.snapshot", Duration::from_secs(3))
        .await
        .expect("a new connection must receive an activity.snapshot");
    let entry = snapshot["users"]
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["user_id"] == member_id.to_string())
        .expect("snapshot should include the member who is listening to something");
    assert_eq!(entry["activities"][0]["details"], "Persisted");

    app.teardown().await;
}

/// ACT-FR-004 dedupe: re-reporting an identical state must not re-broadcast.
#[tokio::test]
async fn identical_report_is_not_rebroadcast() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let (member_token, _member_id) = app.register_member(bootstrap.community_id, "repeat_dj").await;

    let mut owner_ws = WsClient::connect_and_authenticate(&app.ws_url, &bootstrap.owner_token).await;
    let mut member_ws = WsClient::connect_and_authenticate(&app.ws_url, &member_token).await;

    let report = serde_json::json!({ "activities": [listening("Spotify", "Same Song")] });
    member_ws.send("activity.report", report.clone()).await;
    owner_ws
        .recv_op_timeout("activity.update", Duration::from_secs(3))
        .await
        .expect("first report broadcasts");

    member_ws.send("activity.report", report).await;
    let second = owner_ws.recv_op_timeout("activity.update", Duration::from_secs(2)).await;
    assert!(second.is_none(), "an identical re-report must be deduped, got {second:?}");

    app.teardown().await;
}

/// ACT-FR-006: losing the last connection clears the user's activity after
/// the presence grace period.
#[tokio::test]
async fn activity_clears_after_disconnect_grace() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let (member_token, member_id) = app.register_member(bootstrap.community_id, "leaving_dj").await;

    let mut owner_ws = WsClient::connect_and_authenticate(&app.ws_url, &bootstrap.owner_token).await;
    let mut member_ws = WsClient::connect_and_authenticate(&app.ws_url, &member_token).await;
    member_ws
        .send("activity.report", serde_json::json!({ "activities": [listening("Spotify", "Last Call")] }))
        .await;
    owner_ws
        .recv_op_timeout("activity.update", Duration::from_secs(3))
        .await
        .expect("owner sees the activity before disconnect");

    member_ws.close().await;

    // Nothing immediately (grace period), then an empty list once it elapses.
    let mut cleared = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(11);
    while tokio::time::Instant::now() < deadline {
        match owner_ws.recv_op_timeout("activity.update", Duration::from_secs(11)).await {
            Some(update) if update["user_id"] == member_id.to_string() => {
                cleared = Some(update);
                break;
            }
            Some(_) => continue,
            None => break,
        }
    }
    let cleared = cleared.expect("activity.update clearing the member should arrive after the grace period");
    assert_eq!(cleared["activities"].as_array().map(|a| a.len()), Some(0));

    app.teardown().await;
}

/// ACT-FR-007: with two live connections, closing one must not clear the
/// user's activity.
#[tokio::test]
async fn second_connection_closing_keeps_activity() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let (member_token, _member_id) = app.register_member(bootstrap.community_id, "two_device_dj").await;

    let mut owner_ws = WsClient::connect_and_authenticate(&app.ws_url, &bootstrap.owner_token).await;
    let first = WsClient::connect_and_authenticate(&app.ws_url, &member_token).await;
    let mut second = WsClient::connect_and_authenticate(&app.ws_url, &member_token).await;

    second
        .send("activity.report", serde_json::json!({ "activities": [listening("Spotify", "Kept")] }))
        .await;
    owner_ws
        .recv_op_timeout("activity.update", Duration::from_secs(3))
        .await
        .expect("owner sees the activity");

    first.close().await;

    let cleared = owner_ws.recv_op_timeout("activity.update", Duration::from_secs(10)).await;
    assert!(
        cleared.is_none(),
        "closing one of two connections must not clear activity, got {cleared:?}"
    );

    app.teardown().await;
}
