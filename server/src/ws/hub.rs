use std::collections::HashMap;

use axum::extract::ws::Message;
use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

use super::{
    activity::ActivityRegistry, call_registry::CallRegistry, protocol::OutboundEnvelope,
    voice_registry::VoiceRegistry,
};

pub struct ConnHandle {
    pub tx: mpsc::UnboundedSender<Message>,
    pub meta: ConnMeta,
}

/// Per-connection metadata captured at handshake time. Lives on the
/// `ConnHandle` (not a per-user map) because two sockets of the same user can
/// negotiate different protocol versions (old app and new app open at once),
/// and versioned broadcast has to resolve per connection. See SPEC-001 §6.7.
#[derive(Debug, Clone)]
pub struct ConnMeta {
    /// Negotiated version: `min(client, MAX_SERVER_PROTOCOL)`.
    pub protocol_version: u8,
    pub client_version: String,
    pub client_platform: String,
    pub connected_at: chrono::DateTime<chrono::Utc>,
}

/// Tracks connected users and owns the ephemeral call registry. A single
/// `Hub` instance is shared (via `Arc`) across all WebSocket connection
/// tasks so that broadcast (presence, chat) and routed (rtc.*, stream.*)
/// delivery share one source of truth.
pub struct Hub {
    conns: RwLock<HashMap<Uuid, HashMap<Uuid, ConnHandle>>>,
    /// Legacy registry; removed in SPEC-018.
    pub calls: RwLock<CallRegistry>,
    /// v2 registry (SPEC-003). Created here but written by nobody yet —
    /// SPEC-004 migrates the webhook/reconcile writers onto it.
    pub voice: RwLock<VoiceRegistry>,
    /// Ephemeral rich-presence: what each user is playing/listening to.
    /// See SDD/specs/activity.md.
    pub activities: RwLock<ActivityRegistry>,
    /// Manual presence override, set via `presence.set`. Only holds entries
    /// that differ from the connection-derived default — today that means the
    /// single value `"busy"` (Do Not Disturb). Cleared when the user's last
    /// socket drops, so a reconnect starts back at plain "online".
    statuses: RwLock<HashMap<Uuid, String>>,
}

impl Hub {
    pub fn new() -> Self {
        Self {
            conns: RwLock::new(HashMap::new()),
            calls: RwLock::new(CallRegistry::default()),
            voice: RwLock::new(VoiceRegistry::default()),
            activities: RwLock::new(ActivityRegistry::default()),
            statuses: RwLock::new(HashMap::new()),
        }
    }

    /// Record (or clear) a user's manual status override. Anything other than
    /// `"busy"` resets them to the default.
    pub async fn set_status(&self, user_id: Uuid, status: &str) {
        let mut statuses = self.statuses.write().await;
        if status == "busy" {
            statuses.insert(user_id, "busy".to_string());
        } else {
            statuses.remove(&user_id);
        }
    }

    /// Drop any override for a user. Returns whether one existed.
    pub async fn clear_status(&self, user_id: Uuid) -> bool {
        self.statuses.write().await.remove(&user_id).is_some()
    }

    /// The status string to put in a presence payload for `user_id`:
    /// `"offline"` with no live socket, otherwise the manual override
    /// (`"busy"`) or `"online"`.
    pub async fn status_for(&self, user_id: Uuid) -> String {
        if !self.conns.read().await.contains_key(&user_id) {
            return "offline".to_string();
        }
        self.statuses
            .read()
            .await
            .get(&user_id)
            .cloned()
            .unwrap_or_else(|| "online".to_string())
    }

    pub async fn register(
        &self,
        user_id: Uuid,
        tx: mpsc::UnboundedSender<Message>,
        meta: ConnMeta,
    ) -> Uuid {
        let connection_id = Uuid::new_v4();
        self.conns
            .write()
            .await
            .entry(user_id)
            .or_default()
            .insert(connection_id, ConnHandle { tx, meta });
        connection_id
    }

    /// Metadata for every live connection. Used by `GET /api/debug/voice`
    /// (SPEC-002) to answer "who is on which version".
    pub async fn connection_meta(&self) -> Vec<(Uuid, ConnMeta)> {
        self.conns
            .read()
            .await
            .iter()
            .flat_map(|(user_id, handles)| {
                handles.values().map(move |handle| (*user_id, handle.meta.clone()))
            })
            .collect()
    }

    /// Sends `env` only to connections whose negotiated version is `>= min`.
    /// This is the mechanism that keeps a v2 op from reaching a v1 client.
    pub async fn broadcast_to_versioned(
        &self,
        user_ids: &[Uuid],
        min_protocol: u8,
        env: OutboundEnvelope,
    ) {
        let Ok(text) = serde_json::to_string(&env) else {
            return;
        };
        let conns = self.conns.read().await;
        for uid in user_ids {
            if let Some(handles) = conns.get(uid) {
                for handle in handles.values() {
                    if handle.meta.protocol_version >= min_protocol {
                        let _ = handle.tx.send(Message::Text(text.clone()));
                    }
                }
            }
        }
    }

    /// The ceiling counterpart of `broadcast_to_versioned`: sends `env` only to
    /// connections whose negotiated version is `<= max` (a v1-only op).
    /// Used by SPEC-005 to keep the dual projection honest.
    pub async fn broadcast_to_max_version(
        &self,
        user_ids: &[Uuid],
        max_protocol: u8,
        env: OutboundEnvelope,
    ) {
        let Ok(text) = serde_json::to_string(&env) else {
            return;
        };
        let conns = self.conns.read().await;
        for uid in user_ids {
            if let Some(handles) = conns.get(uid) {
                for handle in handles.values() {
                    if handle.meta.protocol_version <= max_protocol {
                        let _ = handle.tx.send(Message::Text(text.clone()));
                    }
                }
            }
        }
    }

    /// Returns true only when this was the user's last authenticated socket.
    pub async fn unregister(&self, user_id: Uuid, connection_id: Uuid) -> bool {
        let mut conns = self.conns.write().await;
        let Some(user_connections) = conns.get_mut(&user_id) else { return false; };
        user_connections.remove(&connection_id);
        if user_connections.is_empty() {
            conns.remove(&user_id);
            true
        } else {
            false
        }
    }

    pub async fn is_online(&self, user_id: Uuid) -> bool {
        self.conns.read().await.contains_key(&user_id)
    }

    pub async fn online_user_ids(&self) -> Vec<Uuid> {
        self.conns.read().await.keys().copied().collect()
    }

    pub async fn send_to(&self, user_id: Uuid, env: OutboundEnvelope) {
        let conns = self.conns.read().await;
        if let Some(handles) = conns.get(&user_id) {
            if let Ok(text) = serde_json::to_string(&env) {
                for handle in handles.values() {
                    let _ = handle.tx.send(Message::Text(text.clone()));
                }
            }
        }
    }

    /// Escape hatch for non-envelope frames (WebSocket protocol-level
    /// Ping/Pong keepalive).
    pub async fn send_to_raw(&self, user_id: Uuid, msg: Message) {
        let conns = self.conns.read().await;
        if let Some(handles) = conns.get(&user_id) {
            for handle in handles.values() {
                let _ = handle.tx.send(msg.clone());
            }
        }
    }

    pub async fn broadcast_all(&self, env: OutboundEnvelope) {
        let Ok(text) = serde_json::to_string(&env) else {
            return;
        };
        let conns = self.conns.read().await;
        for handles in conns.values() {
            for handle in handles.values() {
                let _ = handle.tx.send(Message::Text(text.clone()));
            }
        }
    }

    pub async fn broadcast_to(&self, user_ids: &[Uuid], env: OutboundEnvelope) {
        let Ok(text) = serde_json::to_string(&env) else {
            return;
        };
        let conns = self.conns.read().await;
        for uid in user_ids {
            if let Some(handles) = conns.get(uid) {
                for handle in handles.values() {
                    let _ = handle.tx.send(Message::Text(text.clone()));
                }
            }
        }
    }

    pub async fn send_to_connection(&self, user_id: Uuid, connection_id: Uuid, env: OutboundEnvelope) {
        let Ok(text) = serde_json::to_string(&env) else { return; };
        let conns = self.conns.read().await;
        if let Some(handle) = conns.get(&user_id).and_then(|handles| handles.get(&connection_id)) {
            let _ = handle.tx.send(Message::Text(text));
        }
    }
}

impl Default for Hub {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(protocol_version: u8) -> ConnMeta {
        ConnMeta {
            protocol_version,
            client_version: "test".into(),
            client_platform: "test".into(),
            connected_at: chrono::Utc::now(),
        }
    }

    #[tokio::test]
    async fn connection_meta_reports_each_socket_version_independently() {
        let hub = Hub::new();
        let user = Uuid::new_v4();
        let (tx_v1, _rx_v1) = mpsc::unbounded_channel();
        let (tx_v2, _rx_v2) = mpsc::unbounded_channel();
        hub.register(user, tx_v1, meta(1)).await;
        hub.register(user, tx_v2, meta(2)).await;

        let mut versions: Vec<u8> = hub
            .connection_meta()
            .await
            .into_iter()
            .map(|(_, m)| m.protocol_version)
            .collect();
        versions.sort_unstable();
        assert_eq!(versions, vec![1, 2]);
    }

    #[tokio::test]
    async fn broadcast_to_versioned_skips_lower_version_sockets() {
        let hub = Hub::new();
        let user = Uuid::new_v4();
        let (tx_v1, mut rx_v1) = mpsc::unbounded_channel();
        let (tx_v2, mut rx_v2) = mpsc::unbounded_channel();
        hub.register(user, tx_v1, meta(1)).await;
        hub.register(user, tx_v2, meta(2)).await;

        hub.broadcast_to_versioned(
            &[user],
            2,
            OutboundEnvelope::new("voice.room.state", serde_json::json!({})),
        )
        .await;

        assert!(rx_v2.try_recv().is_ok(), "v2 socket should receive a v2-only op");
        assert!(rx_v1.try_recv().is_err(), "v1 socket must not receive a v2-only op");
    }

    #[tokio::test]
    async fn broadcast_to_max_version_skips_higher_version_sockets() {
        let hub = Hub::new();
        let user = Uuid::new_v4();
        let (tx_v1, mut rx_v1) = mpsc::unbounded_channel();
        let (tx_v2, mut rx_v2) = mpsc::unbounded_channel();
        hub.register(user, tx_v1, meta(1)).await;
        hub.register(user, tx_v2, meta(2)).await;

        hub.broadcast_to_max_version(
            &[user],
            1,
            OutboundEnvelope::new("voice.roster", serde_json::json!({})),
        )
        .await;

        assert!(rx_v1.try_recv().is_ok(), "v1 socket should receive a v1-only op");
        assert!(rx_v2.try_recv().is_err(), "v2 socket must not receive a v1-only op");
    }
}
