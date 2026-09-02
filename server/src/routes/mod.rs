mod activity_assets;
mod auth;
mod attachments;
mod channels;
mod communities;
mod debug;
mod invites;
pub mod messages;
mod media;
mod profile;
mod livekit;

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
        .route("/api/auth/me", get(auth::me))
        .route("/api/me", get(auth::me).patch(profile::update_me))
        .route("/api/me/profile", patch(profile::update_profile))
        .route("/api/me/avatar", post(profile::upload_avatar))
        .route("/api/users/:id", patch(profile::rename_user))
        .route("/api/users/:id/profile", get(profile::get_user_profile))
        .route("/api/users/:id/name-color", patch(profile::set_name_color))
        .route("/api/community", get(communities::current))
        .route("/api/communities", get(communities::list))
        .route("/api/channels", get(channels::list))
        .route("/api/channels", post(channels::create))
        .route("/api/channels/dm/:id", post(channels::open_dm))
        .route("/api/channels/:id", patch(channels::update).delete(channels::delete))
        .route("/api/channels/:id/name", patch(channels::rename))
        .route("/api/channels/categories", post(channels::create_category))
        .route(
            "/api/channels/categories/:id",
            patch(channels::update_category).delete(channels::delete_category),
        )
        .route("/api/communities/:id/channels", get(channels::list_for_community))
        .route("/api/channels/:id/messages", get(messages::history))
        .route("/api/users/:id/avatar", get(media::avatar))
        .route("/api/users/:id/profile-badge", get(media::profile_badge))
        .route("/api/messages/:id/preview-image", get(media::preview_image))
        .route("/api/message-embeds/:id/:slot", get(media::embed_image))
        .route("/api/channels/:id/attachments", post(attachments::upload))
        .route("/api/attachments/:id", get(attachments::download))
        .route("/api/activity-assets", post(activity_assets::upload))
        .route("/api/activity-assets/:id", get(activity_assets::download))
        .route("/api/invites", post(invites::create).get(invites::list))
        .route("/api/invites/:id", delete(invites::revoke))
        .route("/api/livekit/token", post(livekit::token))
        .route("/api/livekit/webhook", post(livekit::webhook))
        .route("/api/debug/voice", get(debug::voice))
}
