use std::env;

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub bind_addr: String,
    pub session_ttl_days: i64,
    pub turn_shared_secret: String,
    pub turn_realm: String,
    pub turn_uris: Vec<String>,
    pub turn_credential_ttl_seconds: i64,
    pub max_attachment_size_bytes: usize,
    pub attachment_storage_path: String,
    pub allowed_origins: Vec<String>,
    pub unattached_attachment_ttl_hours: i64,
    /// Shared only with the music-bot container. It authenticates a real
    /// WebSocket participant without creating an end-user session.
    pub music_bot_token: String,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            database_url: env::var("DATABASE_URL")
                .expect("DATABASE_URL must be set (see server/.env.example)"),
            bind_addr: env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string()),
            session_ttl_days: env::var("SESSION_TTL_DAYS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(30),
            turn_shared_secret: env::var("TURN_SHARED_SECRET")
                .unwrap_or_else(|_| "insecure-dev-secret".to_string()),
            turn_realm: env::var("TURN_REALM").unwrap_or_else(|_| "tupi.local".to_string()),
            turn_uris: env::var("TURN_URIS")
                .unwrap_or_else(|_| "turn:localhost:3478".to_string())
                .split(',')
                .map(|s| s.trim().to_string())
                .collect(),
            turn_credential_ttl_seconds: env::var("TURN_CREDENTIAL_TTL_SECONDS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(3600),
            max_attachment_size_bytes: env::var("MAX_ATTACHMENT_SIZE_BYTES")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(25 * 1024 * 1024),
            attachment_storage_path: env::var("ATTACHMENT_STORAGE_PATH")
                .unwrap_or_else(|_| "./data/attachments".to_string()),
            allowed_origins: env::var("ALLOWED_ORIGINS")
                .unwrap_or_else(|_| "http://localhost:5173".to_string())
                .split(',')
                .map(|origin| origin.trim().to_string())
                .filter(|origin| !origin.is_empty())
                .collect(),
            unattached_attachment_ttl_hours: env::var("UNATTACHED_ATTACHMENT_TTL_HOURS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(24),
            // Existing installations can deploy the bot without a one-off SSH
            // secret edit; production may set a dedicated token to override it.
            music_bot_token: env::var("MUSIC_BOT_TOKEN").ok().filter(|value| !value.is_empty()).unwrap_or_else(|| {
                env::var("TURN_SHARED_SECRET").unwrap_or_else(|_| "insecure-dev-music-bot-token".to_string())
            }),
        }
    }
}
