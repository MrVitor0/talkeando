use std::collections::HashMap;

use axum::extract::ws::Message;
use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

use super::{call_registry::CallRegistry, protocol::OutboundEnvelope};

pub struct ConnHandle {
    pub tx: mpsc::UnboundedSender<Message>,
}

/// Tracks connected users and owns the ephemeral call registry. A single
/// `Hub` instance is shared (via `Arc`) across all WebSocket connection
/// tasks so that broadcast (presence, chat) and routed (rtc.*, stream.*)
/// delivery share one source of truth.
pub struct Hub {
    conns: RwLock<HashMap<Uuid, HashMap<Uuid, ConnHandle>>>,
    pub calls: RwLock<CallRegistry>,
}

impl Hub {
    pub fn new() -> Self {
        Self {
            conns: RwLock::new(HashMap::new()),
            calls: RwLock::new(CallRegistry::default()),
        }
    }

    pub async fn register(&self, user_id: Uuid, tx: mpsc::UnboundedSender<Message>) -> Uuid {
        let connection_id = Uuid::new_v4();
        self.conns
            .write()
            .await
            .entry(user_id)
            .or_default()
            .insert(connection_id, ConnHandle { tx });
        connection_id
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
