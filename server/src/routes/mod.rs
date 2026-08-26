mod auth;
mod channels;
mod communities;
mod invites;
mod messages;
mod turn;

use axum::{
    routing::{delete, get, patch, post},
    Router,
};

use crate::state::AppState;

/// REST only ever carries reads and account/community management. All chat
/// mutation (create/edit/delete) goes through the WebSocket protocol so
/// there is exactly one code path that persists a message and broadcasts it
/// (see SDD/09-websocket-protocol.md) — no duplicate write path to drift
/// out of sync with the realtime one.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/register", post(auth::register))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/me", get(auth::me))
        .route("/api/community", get(communities::current))
        .route("/api/communities", get(communities::list))
        .route("/api/channels", get(channels::list))
        .route("/api/channels", post(channels::create))
        .route("/api/channels/:id", patch(channels::update).delete(channels::delete))
        .route("/api/channels/categories", post(channels::create_category))
        .route(
            "/api/channels/categories/:id",
            patch(channels::update_category).delete(channels::delete_category),
        )
        .route("/api/communities/:id/channels", get(channels::list_for_community))
        .route("/api/channels/:id/messages", get(messages::history))
        .route("/api/invites", post(invites::create).get(invites::list))
        .route("/api/invites/:id", delete(invites::revoke))
        .route("/api/turn-credentials", get(turn::credentials))
}
