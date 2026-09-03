//! SPEC-014: `POST /api/client-logs`.

mod common;

use common::TestApp;

fn report(reason: &str) -> serde_json::Value {
    serde_json::json!({
        "client_version": "1.4.0",
        "protocol_version": 2,
        "server_version": "0.1.0",
        "reason": reason,
        "collected_at": "2026-09-03T00:00:00Z",
        "context": { "channel_id": null, "call_state": "idle", "participants": 0, "watching": 0, "sharing": false, "connection_state": "connected", "user_agent": "test" },
        "entries": [{ "at": "2026-09-03T00:00:00Z", "event": "call.join.failed", "fields": { "reason": "timeout" } }],
    })
}

#[tokio::test]
async fn upload_requires_authentication() {
    let app = TestApp::spawn().await;
    let response = reqwest::Client::new()
        .post(format!("{}/client-logs", app.http_url))
        .json(&report("manual"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    app.teardown().await;
}

#[tokio::test]
async fn upload_writes_a_file() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let response = reqwest::Client::new()
        .post(format!("{}/client-logs", app.http_url))
        .bearer_auth(&bootstrap.owner_token)
        .json(&report("auto:join_failed"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);

    let dir = app
        .state
        .config
        .attachment_storage_path
        .clone();
    let logs = std::path::Path::new(&dir).join("_client_logs");
    let count = std::fs::read_dir(&logs).unwrap().count();
    assert_eq!(count, 1, "one report file expected in {logs:?}");

    app.teardown().await;
}

#[tokio::test]
async fn upload_rejects_oversized_body() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let mut huge = report("manual");
    huge["blob"] = serde_json::Value::String("x".repeat(600 * 1024));

    let response = reqwest::Client::new()
        .post(format!("{}/client-logs", app.http_url))
        .bearer_auth(&bootstrap.owner_token)
        .json(&huge)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 413);
    app.teardown().await;
}

#[tokio::test]
async fn upload_rate_limits_per_user() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let http = reqwest::Client::new();
    let post = || {
        http.post(format!("{}/client-logs", app.http_url))
            .bearer_auth(&bootstrap.owner_token)
            .json(&report("manual"))
            .send()
    };
    assert_eq!(post().await.unwrap().status(), 200);
    assert_eq!(post().await.unwrap().status(), 429);
    app.teardown().await;
}
