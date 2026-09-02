//! Shared integration-test harness. Spins up the *real* router
//! (`talkeando_server::build_app`) against a freshly created, migrated
//! Postgres database — not a mock — bound to an ephemeral local port, so
//! tests exercise the exact same code path as production.
//!
//! Requires a reachable Postgres server; point `TEST_DATABASE_ADMIN_URL` at
//! it (defaults to `postgres://talkeando:talkeando@localhost:5434/postgres`,
//! matching `infra/docker-compose.yml`'s host port). Each `TestApp` creates and drops
//! its own randomly-named database, so tests are isolated from each other
//! and safe to run in parallel (the default `cargo test` behavior).

use sqlx::{postgres::PgPoolOptions, Executor, PgPool};
use tupi_server::{build_app, config::Config, run_migrations, state::AppState};
use uuid::Uuid;

pub struct TestApp {
    pub http_url: String,
    pub ws_url: String,
    pub pool: PgPool,
    /// The live `AppState` the router runs on, so a test can inspect or seed
    /// in-memory state (voice registry, metrics) that has no HTTP surface yet.
    pub state: AppState,
    admin_pool: PgPool,
    db_name: String,
    attachment_dir: std::path::PathBuf,
}

impl TestApp {
    pub async fn spawn() -> Self {
        Self::spawn_inner(None).await
    }

    /// Spawns the app with `config.livekit_url` pointed at a local fake that
    /// answers `ListRooms` / `ListParticipants` from state the test controls.
    pub async fn spawn_with_fake_livekit() -> (Self, FakeLiveKit) {
        let fake = FakeLiveKit::start().await;
        let app = Self::spawn_inner(Some(fake.base_url())).await;
        (app, fake)
    }

    async fn spawn_inner(livekit_url_override: Option<String>) -> Self {
        let admin_url = std::env::var("TEST_DATABASE_ADMIN_URL")
            .unwrap_or_else(|_| "postgres://talkeando:talkeando@localhost:5434/postgres".to_string());
        let admin_pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&admin_url)
            .await
            .expect(
                "connect to a Postgres admin database for tests \
                 (set TEST_DATABASE_ADMIN_URL, or run infra/docker-compose.yml's postgres service)",
            );

        let db_name = format!("tupi_test_{}", Uuid::new_v4().simple());
        admin_pool
            .execute(format!("CREATE DATABASE \"{db_name}\"").as_str())
            .await
            .expect("create per-test database");

        let db_url = replace_database_name(&admin_url, &db_name);
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(&db_url)
            .await
            .expect("connect to freshly created test database");
        run_migrations(&pool).await.expect("run migrations against test database");

        let attachment_dir = std::env::temp_dir().join(format!("tupi-test-attachments-{db_name}"));
        tokio::fs::create_dir_all(&attachment_dir).await.expect("create test attachment dir");

        let config = Config {
            database_url: db_url,
            bind_addr: "127.0.0.1:0".to_string(),
            session_ttl_days: 30,
            turn_shared_secret: "test-shared-secret".to_string(),
            turn_realm: "test.local".to_string(),
            turn_uris: vec!["turn:localhost:3478".to_string()],
            turn_credential_ttl_seconds: 3600,
            max_attachment_size_bytes: 25 * 1024 * 1024,
            attachment_storage_path: attachment_dir.to_string_lossy().to_string(),
            allowed_origins: vec!["http://localhost:5173".to_string()],
            unattached_attachment_ttl_hours: 24,
            music_bot_token: "test-music-bot-token".to_string(),
            livekit_url: Some(
                livekit_url_override.unwrap_or_else(|| "ws://localhost:7880".to_string()),
            ),
            livekit_api_key: Some("APItestkey".to_string()),
            livekit_api_secret: Some("test-livekit-secret".to_string()),
            livekit_token_ttl_seconds: 21_600,
        };

        let state = AppState::new(pool.clone(), config);
        let app = build_app(state.clone());

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind ephemeral test port");
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .expect("test server crashed");
        });

        TestApp {
            http_url: format!("http://{addr}/api"),
            ws_url: format!("ws://{addr}/ws"),
            pool,
            state,
            admin_pool,
            db_name,
            attachment_dir,
        }
    }

    /// Builds and signs a LiveKit webhook exactly as LiveKit does (a JWT whose
    /// `sha256` claim is the base64 of the body's SHA-256, see
    /// `server/src/livekit.rs::verify_webhook`) and POSTs it. Returns the HTTP
    /// status. `event` is the raw webhook JSON object.
    pub async fn send_webhook(&self, event: serde_json::Value) -> reqwest::StatusCode {
        use base64::Engine;
        use sha2::Digest;
        let body = serde_json::to_string(&event).unwrap();
        let hash = base64::engine::general_purpose::STANDARD.encode(sha2::Sha256::digest(body.as_bytes()));
        let claims = serde_json::json!({ "iss": "APItestkey", "sha256": hash });
        let token = sign_hs256(&claims, "test-livekit-secret");
        reqwest::Client::new()
            .post(format!("{}/livekit/webhook", self.http_url))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
            .unwrap()
            .status()
    }

    /// Best-effort cleanup. Call at the end of a test; a panic before this
    /// runs just leaves a small, harmlessly-named test database and temp
    /// dir behind (acceptable at this project's scale — see
    /// SDD/22-testing-strategy.md).
    pub async fn teardown(self) {
        self.pool.close().await;
        let _ = self
            .admin_pool
            .execute(format!("DROP DATABASE IF EXISTS \"{}\" WITH (FORCE)", self.db_name).as_str())
            .await;
        let _ = tokio::fs::remove_dir_all(&self.attachment_dir).await;
    }

    /// Registers a brand-new community + owner via the CLI bootstrap path's
    /// underlying SQL (duplicated intentionally: exercising the real HTTP
    /// bootstrap flow isn't possible since it's a CLI-only command, not a
    /// route — see specs/auth.md "no open self-signup"). Returns
    /// (owner_token, owner_user_id, community_id, general_text_channel_id).
    pub async fn bootstrap(&self) -> Bootstrapped {
        let password_hash = tupi_server::auth::hash_password("owner-password-123").unwrap();
        let community_id: (Uuid,) = sqlx::query_as("INSERT INTO communities (name) VALUES ('Test') RETURNING id")
            .fetch_one(&self.pool)
            .await
            .unwrap();
        let owner_id: (Uuid,) = sqlx::query_as(
            "INSERT INTO users (username, display_name, password_hash) VALUES ('owner', 'Owner', $1) RETURNING id",
        )
        .bind(&password_hash)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO community_members (community_id, user_id, role) VALUES ($1, $2, 'owner')")
            .bind(community_id.0)
            .bind(owner_id.0)
            .execute(&self.pool)
            .await
            .unwrap();
        let category_id: (Uuid,) = sqlx::query_as(
            "INSERT INTO channel_categories (community_id, name, position) VALUES ($1, 'General', 0) RETURNING id",
        )
        .bind(community_id.0)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        let text_channel_id: (Uuid,) = sqlx::query_as(
            "INSERT INTO channels (community_id, category_id, name, kind, position) VALUES ($1, $2, 'general', 'text', 0) RETURNING id",
        )
        .bind(community_id.0)
        .bind(category_id.0)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        let voice_channel_id: (Uuid,) = sqlx::query_as(
            "INSERT INTO channels (community_id, category_id, name, kind, position) VALUES ($1, $2, 'voice', 'voice', 1) RETURNING id",
        )
        .bind(community_id.0)
        .bind(category_id.0)
        .fetch_one(&self.pool)
        .await
        .unwrap();

        let token = self.login("owner", "owner-password-123").await;

        Bootstrapped {
            owner_token: token,
            owner_id: owner_id.0,
            community_id: community_id.0,
            text_channel_id: text_channel_id.0,
            voice_channel_id: voice_channel_id.0,
        }
    }

    /// Creates an invite for `community_id` and registers a new member
    /// through the real `/api/auth/register` HTTP endpoint (unlike the
    /// owner, members always go through the real invite-gated path).
    pub async fn register_member(&self, community_id: Uuid, username: &str) -> (String, Uuid) {
        let code: (String,) = sqlx::query_as(
            "INSERT INTO invites (community_id, created_by, code) \
             SELECT $1, user_id, $2 FROM community_members WHERE community_id = $1 AND role = 'owner' LIMIT 1 \
             RETURNING code",
        )
        .bind(community_id)
        .bind(Uuid::new_v4().simple().to_string())
        .fetch_one(&self.pool)
        .await
        .unwrap();

        let client = reqwest::Client::new();
        let response = client
            .post(format!("{}/auth/register", self.http_url))
            .json(&serde_json::json!({
                "invite_code": code.0,
                "username": username,
                "password": "member-password-123",
                "display_name": username,
            }))
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success(), "register failed: {:?}", response.text().await);
        let body: serde_json::Value = response.json().await.unwrap();
        (
            body["token"].as_str().unwrap().to_string(),
            Uuid::parse_str(body["user"]["id"].as_str().unwrap()).unwrap(),
        )
    }

    pub async fn login(&self, username: &str, password: &str) -> String {
        let client = reqwest::Client::new();
        let response = client
            .post(format!("{}/auth/login", self.http_url))
            .json(&serde_json::json!({ "username": username, "password": password }))
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success(), "login failed: {:?}", response.text().await);
        let body: serde_json::Value = response.json().await.unwrap();
        body["token"].as_str().unwrap().to_string()
    }
}

pub struct Bootstrapped {
    pub owner_token: String,
    pub owner_id: Uuid,
    pub community_id: Uuid,
    pub text_channel_id: Uuid,
    pub voice_channel_id: Uuid,
}

fn replace_database_name(admin_url: &str, db_name: &str) -> String {
    let base = admin_url.rsplit_once('/').map(|(prefix, _)| prefix).unwrap_or(admin_url);
    format!("{base}/{db_name}")
}

/// Minimal real WebSocket client for tests — connects, sends `auth.hello`,
/// and gives typed helpers for the envelope protocol
/// (`SDD/09-websocket-protocol.md`). Deliberately thin: tests should
/// assert on the actual JSON, not a heavily-abstracted wrapper.
pub struct WsClient {
    socket: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    /// The `data` of the `auth.ok` this client received during the handshake.
    /// `Null` only if a caller built the client without authenticating.
    pub auth_ok: serde_json::Value,
}

impl WsClient {
    pub async fn connect_and_authenticate(ws_url: &str, token: &str) -> Self {
        Self::connect_and_authenticate_with(ws_url, token, serde_json::json!({})).await
    }

    /// Like `connect_and_authenticate`, but merges `hello_extra`'s fields into
    /// the `auth.hello` payload — e.g. `json!({ "protocol_version": 2 })`.
    /// The resulting `auth.ok` data is stored on `self.auth_ok`.
    pub async fn connect_and_authenticate_with(
        ws_url: &str,
        token: &str,
        hello_extra: serde_json::Value,
    ) -> Self {
        let (socket, _) = tokio_tungstenite::connect_async(ws_url).await.expect("connect websocket");
        let mut client = WsClient { socket, auth_ok: serde_json::Value::Null };
        let mut hello = serde_json::json!({ "token": token });
        if let Some(extra) = hello_extra.as_object() {
            let obj = hello.as_object_mut().expect("hello is an object");
            for (key, value) in extra {
                obj.insert(key.clone(), value.clone());
            }
        }
        client.send("auth.hello", hello).await;
        let ok = client.recv_op("auth.ok").await;
        assert!(ok.is_some(), "expected auth.ok after auth.hello");
        client.auth_ok = ok.unwrap();
        client
    }

    pub async fn send(&mut self, op: &str, data: serde_json::Value) {
        use futures::SinkExt;
        let envelope = serde_json::json!({ "v": 1, "op": op, "data": data }).to_string();
        self.socket
            .send(tokio_tungstenite::tungstenite::Message::Text(envelope))
            .await
            .expect("send websocket message");
    }

    /// Reads envelopes until one matches `op` (or a 3s timeout elapses),
    /// discarding anything else in between (e.g. presence.snapshot arriving
    /// before the event under test). Returns the `data` field.
    pub async fn recv_op(&mut self, op: &str) -> Option<serde_json::Value> {
        self.recv_op_timeout(op, std::time::Duration::from_secs(3)).await
    }

    /// Same as `recv_op` but with an explicit timeout — needed for events
    /// gated behind the presence disconnect grace period (8s, see
    /// `ws/handler.rs`), which outlast `recv_op`'s default.
    pub async fn recv_op_timeout(&mut self, op: &str, timeout: std::time::Duration) -> Option<serde_json::Value> {
        let op = op.to_string();
        self.recv_matching(timeout, move |envelope| envelope["op"] == op.as_str())
            .await
            .map(|envelope| envelope["data"].clone())
    }

    /// `presence.update` in particular fires for *every* user's connect —
    /// including a client's own, self-directed one (a client is a member of
    /// its own community, so it is in its own broadcast recipient list).
    /// Filtering `recv_op` by op name alone is therefore not enough to
    /// isolate "did *this specific user's* presence change" — use this
    /// instead whenever the test cares about one particular user_id.
    pub async fn recv_presence_update_for(&mut self, user_id: uuid::Uuid, timeout: std::time::Duration) -> Option<serde_json::Value> {
        let target = user_id.to_string();
        self.recv_matching(timeout, move |envelope| {
            envelope["op"] == "presence.update" && envelope["data"]["user_id"] == target.as_str()
        })
        .await
        .map(|envelope| envelope["data"].clone())
    }

    /// Public escape hatch: read envelopes until `predicate` matches the whole
    /// envelope, or `timeout` elapses.
    pub async fn recv_matching_pub(
        &mut self,
        timeout: std::time::Duration,
        predicate: impl Fn(&serde_json::Value) -> bool,
    ) -> Option<serde_json::Value> {
        self.recv_matching(timeout, predicate).await
    }

    /// Reads envelopes (discarding non-matching ones, e.g. an unrelated
    /// presence.snapshot) until `predicate` matches the full envelope, or
    /// `timeout` elapses. Returns the whole envelope (not just `data`) so
    /// callers can inspect `op` too if needed.
    async fn recv_matching(
        &mut self,
        timeout: std::time::Duration,
        predicate: impl Fn(&serde_json::Value) -> bool,
    ) -> Option<serde_json::Value> {
        use futures::StreamExt;
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return None;
            }
            let next = tokio::time::timeout(remaining, self.socket.next()).await.ok()??;
            let msg = next.ok()?;
            let tokio_tungstenite::tungstenite::Message::Text(text) = msg else { continue };
            let envelope: serde_json::Value = serde_json::from_str(&text).ok()?;
            if predicate(&envelope) {
                return Some(envelope);
            }
        }
    }

    /// Closes the connection with a normal WS close frame — simulates a
    /// clean client disconnect (app closed, user logged out, etc.) as
    /// opposed to an abrupt network drop. The server's teardown path does
    /// not currently distinguish the two (see `ws/handler.rs`), so this is
    /// also what a `presence.md` "8 second grace period" test needs.
    pub async fn close(mut self) {
        let _ = self.socket.close(None).await;
    }
}

/// Signs a compact HS256 JWT the same way `server/src/livekit.rs` does
/// (URL-safe base64, no padding). Used to forge LiveKit webhook auth.
fn sign_hs256(claims: &serde_json::Value, secret: &str) -> String {
    use base64::Engine;
    use hmac::Mac;
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let header = b64.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = b64.encode(serde_json::to_vec(claims).unwrap());
    let signing_input = format!("{header}.{payload}");
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(signing_input.as_bytes());
    let signature = b64.encode(mac.finalize().into_bytes());
    format!("{signing_input}.{signature}")
}

/// One participant as the fake LiveKit should report them.
#[derive(Clone)]
pub struct FakeParticipant {
    pub identity: String,
    pub sid: String,
    pub hidden: bool,
    /// `(track_sid, LiveKit source, muted)` — source e.g. `"SCREEN_SHARE"`.
    pub tracks: Vec<(String, String, bool)>,
}

impl FakeParticipant {
    pub fn new(identity: uuid::Uuid, sid: &str) -> Self {
        Self { identity: identity.to_string(), sid: sid.to_string(), hidden: false, tracks: Vec::new() }
    }
    pub fn hidden(mut self) -> Self {
        self.hidden = true;
        self
    }
    pub fn with_track(mut self, track_sid: &str, source: &str) -> Self {
        self.tracks.push((track_sid.to_string(), source.to_string(), false));
        self
    }
}

type FakeRooms = std::collections::HashMap<String, Vec<FakeParticipant>>;

/// A local HTTP server that answers the two LiveKit RoomService endpoints the
/// reconcile path calls, from state the test mutates via `set_room`.
pub struct FakeLiveKit {
    base_url: String,
    rooms: std::sync::Arc<tokio::sync::Mutex<FakeRooms>>,
}

impl FakeLiveKit {
    async fn start() -> Self {
        use axum::{routing::post, Json, Router};
        let rooms: std::sync::Arc<tokio::sync::Mutex<FakeRooms>> = Default::default();

        let list_rooms_rooms = rooms.clone();
        let list_participants_rooms = rooms.clone();
        let router = Router::new()
            .route(
                "/twirp/livekit.RoomService/ListRooms",
                post(move || {
                    let rooms = list_rooms_rooms.clone();
                    async move {
                        let guard = rooms.lock().await;
                        let names: Vec<_> = guard
                            .iter()
                            .filter(|(_, p)| !p.is_empty())
                            .map(|(name, _)| serde_json::json!({ "name": name }))
                            .collect();
                        Json(serde_json::json!({ "rooms": names }))
                    }
                }),
            )
            .route(
                "/twirp/livekit.RoomService/ListParticipants",
                post(move |Json(body): Json<serde_json::Value>| {
                    let rooms = list_participants_rooms.clone();
                    async move {
                        let room = body["room"].as_str().unwrap_or_default().to_string();
                        let guard = rooms.lock().await;
                        let participants: Vec<_> = guard
                            .get(&room)
                            .into_iter()
                            .flatten()
                            .map(|p| {
                                serde_json::json!({
                                    "identity": p.identity,
                                    "sid": p.sid,
                                    "state": "ACTIVE",
                                    "permission": { "hidden": p.hidden, "canPublish": true },
                                    "tracks": p.tracks.iter().map(|(sid, source, muted)| serde_json::json!({
                                        "sid": sid, "source": source, "muted": muted,
                                    })).collect::<Vec<_>>(),
                                })
                            })
                            .collect();
                        Json(serde_json::json!({ "participants": participants }))
                    }
                }),
            );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self { base_url: format!("http://{addr}"), rooms }
    }

    fn base_url(&self) -> String {
        self.base_url.clone()
    }

    /// Sets the exact participant list the fake reports for `room` (a channel
    /// UUID string). An empty list makes the room disappear from `ListRooms`.
    pub async fn set_room(&self, room: impl Into<String>, participants: Vec<FakeParticipant>) {
        self.rooms.lock().await.insert(room.into(), participants);
    }
}
