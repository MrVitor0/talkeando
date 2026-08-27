pub mod auth;
pub mod config;
pub mod db;
pub mod discord_import;
pub mod error;
pub mod routes;
pub mod state;
pub mod telemetry;
pub mod ws;

use axum::http::{header, HeaderValue, Method};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

use crate::state::AppState;

/// Builds the full HTTP+WS router (routes, CORS, body limits, tracing).
/// Shared by the real binary (`main.rs`) and the integration test harness
/// (`tests/common`) so tests exercise the exact same middleware stack as
/// production rather than a hand-rolled subset that could silently drift.
pub fn build_app(state: AppState) -> axum::Router {
    let body_limit = state.config.max_attachment_size_bytes + 1024 * 1024;
    let allowed_origins: Vec<HeaderValue> = state
        .config
        .allowed_origins
        .iter()
        .filter_map(|origin| origin.parse().ok())
        .collect();
    routes::router()
        .route("/ws", axum::routing::get(ws::ws_upgrade))
        .layer(axum::extract::DefaultBodyLimit::max(body_limit))
        .layer(
            CorsLayer::new()
                .allow_origin(allowed_origins)
                .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE])
                .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

pub async fn run_migrations(pool: &sqlx::PgPool) -> Result<(), sqlx::migrate::MigrateError> {
    sqlx::migrate!("./migrations").run(pool).await
}
