pub mod activity;
pub mod call_registry;
pub mod handler;
pub mod hub;
pub mod projection;
pub mod protocol;
pub mod voice_metrics;
pub mod voice_registry;

pub use handler::ws_upgrade;

/// Capabilities this server advertises in `auth.ok.features`. Each spec that
/// ships a capability adds its name here, never before (SPEC-001 §4.5).
/// SPEC-014 adds `"client.logs"`.
pub fn server_features(config: &crate::config::Config) -> Vec<String> {
    let mut features = Vec::new();
    if config.voice_protocol_v2 {
        features.push("voice.room.v2".to_string());
        features.push("voice.hints".to_string());
    }
    features
}
