//! Integration coverage for the voice/signaling protocol. SPEC-001 seeds this
//! file with the protocol-version negotiation cases; SPEC-003–006 grow it into
//! the full webhook + WS voice suite.

mod common;

use common::{TestApp, WsClient};

/// A client that sends `auth.hello` with no protocol fields (a v1 client)
/// negotiates version 1 and gets an empty `features` list, and the handshake
/// otherwise behaves exactly as before.
#[tokio::test]
async fn hello_without_protocol_version_negotiates_v1() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let client = WsClient::connect_and_authenticate(&app.ws_url, &bootstrap.owner_token).await;

    assert_eq!(client.auth_ok["protocol_version"], 1);
    assert_eq!(client.auth_ok["features"], serde_json::json!([]));
    assert!(
        client.auth_ok["server_version"].as_str().is_some_and(|v| !v.is_empty()),
        "server_version must be present and non-empty: {:?}",
        client.auth_ok
    );
}

/// A client that asks for protocol version 2 gets version 2 back, but still an
/// empty `features` list in this spec — so it must fall back to the v1 dialect.
#[tokio::test]
async fn hello_with_v2_negotiates_v2_and_reports_features() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let client = WsClient::connect_and_authenticate_with(
        &app.ws_url,
        &bootstrap.owner_token,
        serde_json::json!({ "protocol_version": 2, "client_platform": "dev" }),
    )
    .await;

    assert_eq!(client.auth_ok["protocol_version"], 2);
    assert_eq!(client.auth_ok["features"], serde_json::json!([]));
}

/// An absurd requested version is clamped down to the server ceiling, never
/// rejected.
#[tokio::test]
async fn hello_with_absurd_version_is_clamped_to_server_max() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let client = WsClient::connect_and_authenticate_with(
        &app.ws_url,
        &bootstrap.owner_token,
        serde_json::json!({ "protocol_version": 99 }),
    )
    .await;

    assert_eq!(client.auth_ok["protocol_version"], 2);
}

/// Version 0 is a legal request; it is equivalent to v1 for every purpose and
/// must not be treated as an error.
#[tokio::test]
async fn hello_with_version_zero_still_authenticates() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let client = WsClient::connect_and_authenticate_with(
        &app.ws_url,
        &bootstrap.owner_token,
        serde_json::json!({ "protocol_version": 0 }),
    )
    .await;

    assert_eq!(client.auth_ok["protocol_version"], 0);
}

/// A pathologically long `client_version` must not break the handshake — the
/// server truncates it before storing (verified exactly by the `truncate_chars`
/// unit tests in `ws::handler`). Here we only assert the connection still
/// completes.
#[tokio::test]
async fn client_version_is_truncated_to_64_chars() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let huge = "v".repeat(10_000);
    let client = WsClient::connect_and_authenticate_with(
        &app.ws_url,
        &bootstrap.owner_token,
        serde_json::json!({ "protocol_version": 1, "client_version": huge }),
    )
    .await;

    assert_eq!(client.auth_ok["protocol_version"], 1);
}

// ---- SPEC-002: GET /api/debug/voice ----

#[tokio::test]
async fn debug_endpoint_requires_owner() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let (member_token, _member_id) = app.register_member(bootstrap.community_id, "member").await;

    let http = reqwest::Client::new();
    let owner = http
        .get(format!("{}/debug/voice", app.http_url))
        .bearer_auth(&bootstrap.owner_token)
        .send()
        .await
        .unwrap();
    assert_eq!(owner.status(), 200);

    let member = http
        .get(format!("{}/debug/voice", app.http_url))
        .bearer_auth(&member_token)
        .send()
        .await
        .unwrap();
    assert_eq!(member.status(), 403);

    app.teardown().await;
}

#[tokio::test]
async fn debug_endpoint_lists_connection_versions() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;

    let _v1 = WsClient::connect_and_authenticate(&app.ws_url, &bootstrap.owner_token).await;
    let _v2 = WsClient::connect_and_authenticate_with(
        &app.ws_url,
        &bootstrap.owner_token,
        serde_json::json!({ "protocol_version": 2 }),
    )
    .await;

    let http = reqwest::Client::new();
    let body: serde_json::Value = http
        .get(format!("{}/debug/voice", app.http_url))
        .bearer_auth(&bootstrap.owner_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let versions: Vec<u64> = body["connections"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["user_id"] == serde_json::json!(bootstrap.owner_id))
        .filter_map(|c| c["protocol_version"].as_u64())
        .collect();
    assert!(versions.contains(&1), "expected a v1 connection: {body:#}");
    assert!(versions.contains(&2), "expected a v2 connection: {body:#}");

    app.teardown().await;
}

#[tokio::test]
async fn debug_endpoint_survives_livekit_being_down() {
    // The test config points livekit_url at a port with nothing listening, so
    // `live=1` must degrade to 200 with `livekit_diff: null` + `live_error`.
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;

    let http = reqwest::Client::new();
    let response = http
        .get(format!("{}/debug/voice?live=1", app.http_url))
        .bearer_auth(&bootstrap.owner_token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);

    let body: serde_json::Value = response.json().await.unwrap();
    assert!(body["livekit_diff"].is_null(), "expected null diff: {body:#}");
    assert!(body["live_error"].is_string(), "expected live_error: {body:#}");

    app.teardown().await;
}

#[tokio::test]
async fn debug_endpoint_reports_orphan_channel() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;

    // A registry row for a channel with no `channels` table entry — exactly
    // the kind of leak this endpoint exists to reveal.
    let orphan_channel = uuid::Uuid::new_v4();
    app.state
        .hub
        .calls
        .write()
        .await
        .apply_participant(orphan_channel, bootstrap.owner_id, true);

    let http = reqwest::Client::new();
    let body: serde_json::Value = http
        .get(format!("{}/debug/voice", app.http_url))
        .bearer_auth(&bootstrap.owner_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let room = body["rooms"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["channel_id"] == serde_json::json!(orphan_channel))
        .unwrap_or_else(|| panic!("orphan channel missing from rooms: {body:#}"));
    assert!(room["channel_name"].is_null(), "orphan must have null name: {room:#}");

    app.teardown().await;
}
