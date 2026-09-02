//! Integration coverage for the voice/signaling protocol. SPEC-001 seeds this
//! file with the protocol-version negotiation cases; SPEC-003–006 grow it into
//! the full webhook + WS voice suite.

mod common;

use common::{FakeParticipant, TestApp, WsClient};
use uuid::Uuid;

/// Convenience: the `data` block of the first `voice.roster` for `channel_id`.
async fn next_roster(ws: &mut WsClient, channel_id: Uuid) -> serde_json::Value {
    let target = channel_id.to_string();
    ws.recv_matching_pub(std::time::Duration::from_secs(3), move |env| {
        env["op"] == "voice.roster" && env["data"]["channel_id"] == target.as_str()
    })
    .await
    .expect("expected a voice.roster")["data"]
        .clone()
}

/// GETs `/api/debug/voice` as the owner and returns the parsed body.
async fn debug_voice(app: &TestApp, owner_token: &str) -> serde_json::Value {
    reqwest::Client::new()
        .get(format!("{}/debug/voice", app.http_url))
        .bearer_auth(owner_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

fn room_in<'a>(body: &'a serde_json::Value, channel_id: Uuid) -> Option<&'a serde_json::Value> {
    body["rooms"]
        .as_array()?
        .iter()
        .find(|r| r["channel_id"] == serde_json::json!(channel_id))
}

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
        .voice
        .write()
        .await
        .webhook_participant_joined(orphan_channel, bootstrap.owner_id, "PA_orphan".into());

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

// ---- SPEC-004: webhook v2 + directed reconcile ----

fn wh(event: &str, channel: Uuid, extra: serde_json::Value) -> serde_json::Value {
    let mut base = serde_json::json!({
        "event": event,
        "id": Uuid::new_v4().to_string(),
        "createdAt": chrono::Utc::now().timestamp(),
        "room": { "name": channel.to_string() },
    });
    let obj = base.as_object_mut().unwrap();
    for (k, v) in extra.as_object().unwrap() {
        obj.insert(k.clone(), v.clone());
    }
    base
}

/// I-01 — a `participant_joined` webhook fans out to the whole community.
#[tokio::test]
async fn webhook_join_appears_in_roster_for_whole_community() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let channel = bootstrap.voice_channel_id;
    let mut ws = WsClient::connect_and_authenticate(&app.ws_url, &bootstrap.owner_token).await;

    let status = app
        .send_webhook(wh(
            "participant_joined",
            channel,
            serde_json::json!({ "participant": { "identity": bootstrap.owner_id.to_string(), "sid": "PA_1" } }),
        ))
        .await;
    assert_eq!(status, 200);

    let roster = next_roster(&mut ws, channel).await;
    let ids: Vec<&str> = roster["participants"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["user_id"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&bootstrap.owner_id.to_string().as_str()), "roster: {roster:#}");

    app.teardown().await;
}

/// I-06 — a `participant_left` carrying an old sid is ignored (INV-B2).
#[tokio::test]
async fn stale_participant_left_is_ignored() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let channel = bootstrap.voice_channel_id;
    let user = bootstrap.owner_id;

    app.send_webhook(wh("participant_joined", channel,
        serde_json::json!({ "participant": { "identity": user.to_string(), "sid": "PA_new" } }))).await;
    app.send_webhook(wh("participant_left", channel,
        serde_json::json!({ "participant": { "identity": user.to_string(), "sid": "PA_old" } }))).await;

    let body = debug_voice(&app, &bootstrap.owner_token).await;
    let room = room_in(&body, channel).expect("room present");
    assert_eq!(room["participants"].as_array().unwrap().len(), 1, "{room:#}");
    assert_eq!(room["participants"][0]["participant_sid"], "PA_new");

    app.teardown().await;
}

/// I-07 — republishing a screen swaps the track_sid; the v1 projection shows
/// exactly one screen stream and its msid is the new sid.
#[tokio::test]
async fn republish_screen_swaps_track_sid() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let channel = bootstrap.voice_channel_id;
    let user = bootstrap.owner_id;
    let mut ws = WsClient::connect_and_authenticate(&app.ws_url, &bootstrap.owner_token).await;

    let join = serde_json::json!({ "participant": { "identity": user.to_string(), "sid": "PA_1" } });
    app.send_webhook(wh("participant_joined", channel, join)).await;

    let published = |track_sid: &str| serde_json::json!({
        "participant": { "identity": user.to_string(), "sid": "PA_1" },
        "track": { "sid": track_sid, "source": "screen_share", "muted": false },
    });
    app.send_webhook(wh("track_published", channel, published("TR_1"))).await;
    app.send_webhook(wh("track_unpublished", channel, published("TR_1"))).await;
    app.send_webhook(wh("track_published", channel, published("TR_2"))).await;

    // Drain to the most recent roster.
    let mut last = next_roster(&mut ws, channel).await;
    while let Some(env) = ws
        .recv_matching_pub(std::time::Duration::from_millis(300), |e| {
            e["op"] == "voice.roster" && e["data"]["channel_id"] == channel.to_string().as_str()
        })
        .await
    {
        last = env["data"].clone();
    }

    let screens: Vec<&serde_json::Value> = last["streams"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["kind"] == "screen")
        .collect();
    assert_eq!(screens.len(), 1, "exactly one screen stream: {last:#}");
    assert_eq!(screens[0]["msid"], "TR_2");

    app.teardown().await;
}

/// I-08 — the new track published before the old is torn down: only the new
/// one survives.
#[tokio::test]
async fn out_of_order_republish_keeps_new_track() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let channel = bootstrap.voice_channel_id;
    let user = bootstrap.owner_id;

    app.send_webhook(wh("participant_joined", channel,
        serde_json::json!({ "participant": { "identity": user.to_string(), "sid": "PA_1" } }))).await;
    let published = |track_sid: &str| serde_json::json!({
        "participant": { "identity": user.to_string(), "sid": "PA_1" },
        "track": { "sid": track_sid, "source": "screen_share", "muted": false },
    });
    app.send_webhook(wh("track_published", channel, published("TR_1"))).await;
    app.send_webhook(wh("track_published", channel, published("TR_2"))).await;
    app.send_webhook(wh("track_unpublished", channel, published("TR_1"))).await;

    let body = debug_voice(&app, &bootstrap.owner_token).await;
    let room = room_in(&body, channel).unwrap();
    let sids: Vec<&str> = room["tracks"].as_array().unwrap().iter().map(|t| t["track_sid"].as_str().unwrap()).collect();
    assert_eq!(sids, vec!["TR_2"], "{room:#}");

    app.teardown().await;
}

/// I-11 — the same webhook delivered twice bumps the channel version once.
#[tokio::test]
async fn duplicate_webhook_is_idempotent() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let channel = bootstrap.voice_channel_id;

    let event = wh("participant_joined", channel,
        serde_json::json!({ "participant": { "identity": bootstrap.owner_id.to_string(), "sid": "PA_1" } }));
    assert_eq!(app.send_webhook(event.clone()).await, 200);
    assert_eq!(app.send_webhook(event).await, 200); // exact redelivery

    let body = debug_voice(&app, &bootstrap.owner_token).await;
    assert_eq!(room_in(&body, channel).unwrap()["version"], 1, "{body:#}");

    app.teardown().await;
}

/// I-09 — a hidden (spectator) participant never lands in a roster (INV-B3).
#[tokio::test]
async fn hidden_participant_never_in_roster() {
    let (app, fake) = TestApp::spawn_with_fake_livekit().await;
    let bootstrap = app.bootstrap().await;
    let channel = bootstrap.voice_channel_id;
    let a = Uuid::new_v4();
    let spy = Uuid::new_v4();

    fake.set_room(
        channel.to_string(),
        vec![
            FakeParticipant::new(a, "PA_a"),
            FakeParticipant::new(spy, "PA_spy").hidden(),
        ],
    )
    .await;
    tupi_server::ws::handler::reconcile_voice_rooms(&app.state).await;

    let body = debug_voice(&app, &bootstrap.owner_token).await;
    let room = room_in(&body, channel).unwrap();
    let ids: Vec<&str> = room["participants"].as_array().unwrap().iter().map(|p| p["user_id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec![a.to_string()], "spectator leaked: {room:#}");

    app.teardown().await;
}

/// I-04 — reconcile removes a participant LiveKit stopped reporting.
#[tokio::test]
async fn reconcile_removes_participant_livekit_dropped() {
    let (app, fake) = TestApp::spawn_with_fake_livekit().await;
    let bootstrap = app.bootstrap().await;
    let channel = bootstrap.voice_channel_id;
    let (a, b) = (Uuid::new_v4(), Uuid::new_v4());

    fake.set_room(channel.to_string(), vec![FakeParticipant::new(a, "PA_a"), FakeParticipant::new(b, "PA_b")]).await;
    tupi_server::ws::handler::reconcile_voice_rooms(&app.state).await;
    assert_eq!(room_in(&debug_voice(&app, &bootstrap.owner_token).await, channel).unwrap()["participants"].as_array().unwrap().len(), 2);

    fake.set_room(channel.to_string(), vec![FakeParticipant::new(a, "PA_a")]).await;
    tupi_server::ws::handler::reconcile_voice_rooms(&app.state).await;
    let room = room_in(&debug_voice(&app, &bootstrap.owner_token).await, channel).unwrap().clone();
    let ids: Vec<&str> = room["participants"].as_array().unwrap().iter().map(|p| p["user_id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec![a.to_string()], "{room:#}");

    app.teardown().await;
}

/// I-05 — reconcile rebuilds the roster after the registry is wiped (symptom 2).
#[tokio::test]
async fn reconcile_restores_state_after_registry_wipe() {
    let (app, fake) = TestApp::spawn_with_fake_livekit().await;
    let bootstrap = app.bootstrap().await;
    let channel = bootstrap.voice_channel_id;
    let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
    fake.set_room(channel.to_string(), vec![FakeParticipant::new(a, "PA_a"), FakeParticipant::new(b, "PA_b")]).await;

    // Registry starts empty (fresh process); one reconcile fills it.
    tupi_server::ws::handler::reconcile_voice_rooms(&app.state).await;

    let room = room_in(&debug_voice(&app, &bootstrap.owner_token).await, channel).unwrap().clone();
    assert_eq!(room["participants"].as_array().unwrap().len(), 2, "{room:#}");

    app.teardown().await;
}

/// I-10 — `room_finished` schedules a reconcile instead of wiping; with the
/// room still populated at LiveKit, nobody is removed (RC-04).
#[tokio::test]
async fn room_finished_triggers_reconcile_not_wipe() {
    let (app, fake) = TestApp::spawn_with_fake_livekit().await;
    let bootstrap = app.bootstrap().await;
    let channel = bootstrap.voice_channel_id;
    let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
    fake.set_room(channel.to_string(), vec![FakeParticipant::new(a, "PA_a"), FakeParticipant::new(b, "PA_b")]).await;
    tupi_server::ws::handler::reconcile_voice_rooms(&app.state).await;

    assert_eq!(app.send_webhook(wh("room_finished", channel, serde_json::json!({}))).await, 200);
    // The webhook itself must not have wiped the room...
    assert_eq!(
        room_in(&debug_voice(&app, &bootstrap.owner_token).await, channel).unwrap()["participants"]
            .as_array()
            .unwrap()
            .len(),
        2,
        "room_finished wiped the room outright"
    );
    // ...and it must have queued a directed reconcile that, given the room is
    // still populated at LiveKit, changes nothing.
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    let due = app.state.take_due_reconciles().await;
    assert_eq!(due, vec![channel], "room_finished must schedule a reconcile of that channel");
    for channel_id in due {
        tupi_server::ws::handler::reconcile_one_room(&app.state, channel_id).await;
    }

    let room = room_in(&debug_voice(&app, &bootstrap.owner_token).await, channel).unwrap().clone();
    assert_eq!(room["participants"].as_array().unwrap().len(), 2, "directed reconcile wiped a live room: {room:#}");

    app.teardown().await;
}

/// I-18 — a `participant` token is refused with 409 once the channel holds its
/// human cap; a `spectator` token is still granted (INV-F2).
#[tokio::test]
async fn token_refused_when_channel_full() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let channel = bootstrap.voice_channel_id;
    let (member_token, _member_id) = app.register_member(bootstrap.community_id, "eleventh").await;

    {
        let mut voice = app.state.hub.voice.write().await;
        for i in 0..10u128 {
            voice.webhook_participant_joined(channel, Uuid::from_u128(0xA000 + i), format!("PA_{i}"));
        }
    }

    let http = reqwest::Client::new();
    let ask = |mode: &str| {
        http.post(format!("{}/livekit/token", app.http_url))
            .bearer_auth(&member_token)
            .json(&serde_json::json!({ "channel_id": channel, "mode": mode }))
            .send()
    };
    assert_eq!(ask("participant").await.unwrap().status(), 409);
    assert_eq!(ask("spectator").await.unwrap().status(), 200);

    app.teardown().await;
}

/// I-15 — the v1 `stream_id` for one share is stable across broadcasts.
#[tokio::test]
async fn v1_stream_id_is_stable_across_two_broadcasts() {
    let app = TestApp::spawn().await;
    let bootstrap = app.bootstrap().await;
    let channel = bootstrap.voice_channel_id;
    let user = bootstrap.owner_id;
    let mut ws = WsClient::connect_and_authenticate(&app.ws_url, &bootstrap.owner_token).await;

    app.send_webhook(wh("participant_joined", channel,
        serde_json::json!({ "participant": { "identity": user.to_string(), "sid": "PA_1" } }))).await;
    app.send_webhook(wh("track_published", channel, serde_json::json!({
        "participant": { "identity": user.to_string(), "sid": "PA_1" },
        "track": { "sid": "TR_1", "source": "screen_share", "muted": false },
    }))).await;
    let first = next_roster(&mut ws, channel).await;
    let stream_id_1 = first["streams"].as_array().unwrap().iter()
        .find(|s| s["kind"] == "screen").unwrap()["stream_id"].as_str().unwrap().to_string();

    // A second, unrelated broadcast for the same channel.
    app.send_webhook(wh("track_muted", channel, serde_json::json!({
        "track": { "sid": "TR_1", "source": "screen_share", "muted": true },
    }))).await;
    let second = next_roster(&mut ws, channel).await;
    let stream_id_2 = second["streams"].as_array().unwrap().iter()
        .find(|s| s["kind"] == "screen").unwrap()["stream_id"].as_str().unwrap().to_string();

    assert_eq!(stream_id_1, stream_id_2);

    app.teardown().await;
}
