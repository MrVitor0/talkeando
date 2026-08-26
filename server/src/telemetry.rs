use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/// Structured logging (OBS-NFR-001). JSON in all environments so logs stay
/// machine-parseable; fields carried per-event via `tracing::info!(...)`
/// (request/user/session/channel/call/peer/stream ids where available).
/// Never log tokens or password hashes — see SDD/16-security.md.
pub fn init() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().json().with_target(true))
        .init();
}
