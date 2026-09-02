pub mod activity;
pub mod call_registry;
pub mod handler;
pub mod hub;
pub mod protocol;
pub mod voice_metrics;

pub use handler::ws_upgrade;

/// Capabilities this server advertises in `auth.ok.features`. Each spec that
/// ships a capability adds its name here, never before (SPEC-001 §4.5).
/// SPEC-005 adds `"voice.room.v2"` and `"voice.hints"`; SPEC-014 adds
/// `"client.logs"`.
pub fn server_features(_config: &crate::config::Config) -> Vec<String> {
    Vec::new()
}
