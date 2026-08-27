//! Wire format for the Talkeando signaling/chat/presence WebSocket protocol.
//! Canonical catalog: SDD/09-websocket-protocol.md. Envelope shape:
//! `{ "v": 1, "op": "<namespace>.<action>", "data": { ... } }`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct InboundEnvelope {
    #[allow(dead_code)]
    pub v: u8,
    pub op: String,
    #[serde(default)]
    pub data: Value,
}

#[derive(Debug, Serialize)]
pub struct OutboundEnvelope {
    pub v: u8,
    pub op: String,
    pub data: Value,
}

impl OutboundEnvelope {
    pub fn new(op: &str, data: impl Serialize) -> Self {
        Self {
            v: 1,
            op: op.to_string(),
            data: serde_json::to_value(data).unwrap_or(Value::Null),
        }
    }

    pub fn error(code: &str, message: impl Into<String>, in_reply_to: Option<&str>) -> Self {
        Self::new(
            "error",
            ErrorData {
                code: code.to_string(),
                message: message.into(),
                in_reply_to: in_reply_to.map(|s| s.to_string()),
            },
        )
    }
}

#[derive(Debug, Serialize)]
pub struct ErrorData {
    pub code: String,
    pub message: String,
    pub in_reply_to: Option<String>,
}

// ---- auth.* ----

#[derive(Debug, Deserialize)]
pub struct AuthHello {
    pub token: String,
}

#[derive(Debug, Serialize)]
pub struct AuthOk {
    pub user_id: Uuid,
    pub username: String,
    pub display_name: String,
}

// ---- presence.* ----

#[derive(Debug, Serialize, Clone)]
pub struct PresenceEntry {
    pub user_id: Uuid,
    pub status: String, // "online" | "offline"
}

#[derive(Debug, Serialize)]
pub struct PresenceSnapshot {
    pub users: Vec<PresenceEntry>,
}

#[derive(Debug, Serialize, Clone)]
pub struct PresenceUpdate {
    pub user_id: Uuid,
    pub status: String,
}

// ---- chat.* ----

#[derive(Debug, Deserialize)]
pub struct ChatMessageCreate {
    pub channel_id: Uuid,
    pub content: String,
    #[serde(default)]
    pub attachment_ids: Vec<Uuid>,
    #[serde(default)]
    pub req_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ChatMessageEdit {
    pub message_id: Uuid,
    pub content: String,
    #[serde(default)]
    pub req_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ChatMessageDelete {
    pub message_id: Uuid,
    #[serde(default)]
    pub req_id: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct MessageDto {
    pub id: Uuid,
    pub channel_id: Uuid,
    pub author_id: Uuid,
    pub content: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub edited_at: Option<chrono::DateTime<chrono::Utc>>,
    pub attachment_ids: Vec<Uuid>,
}

#[derive(Debug, Serialize)]
pub struct ChatMessageCreated {
    pub message: MessageDto,
    pub in_reply_to: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ChatMessageEdited {
    pub message_id: Uuid,
    pub content: String,
    pub edited_at: Option<chrono::DateTime<chrono::Utc>>,
    pub in_reply_to: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ChatMessageDeleted {
    pub message_id: Uuid,
    pub channel_id: Uuid,
    pub in_reply_to: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ChatTyping {
    pub channel_id: Uuid,
}

// ---- call.* ----

#[derive(Debug, Deserialize)]
pub struct CallJoin {
    pub channel_id: Uuid,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub deafened: bool,
}

#[derive(Debug, Deserialize)]
pub struct CallLeave {
    pub channel_id: Uuid,
}

#[derive(Debug, Deserialize)]
pub struct CallStateUpdate {
    pub channel_id: Uuid,
    pub muted: Option<bool>,
    pub deafened: Option<bool>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ParticipantDto {
    pub user_id: Uuid,
    pub muted: bool,
    pub deafened: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct StreamDto {
    pub stream_id: Uuid,
    pub owner: Uuid,
    pub kind: String,
    pub label: Option<String>,
    pub has_audio: bool,
}

#[derive(Debug, Serialize)]
pub struct CallSnapshot {
    pub channel_id: Uuid,
    pub participants: Vec<ParticipantDto>,
    pub streams: Vec<StreamDto>,
}

#[derive(Debug, Serialize, Clone)]
pub struct CallPeerJoined {
    pub channel_id: Uuid,
    pub participant: ParticipantDto,
}

#[derive(Debug, Serialize, Clone)]
pub struct CallPeerLeft {
    pub channel_id: Uuid,
    pub user_id: Uuid,
    pub reason: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct CallStateUpdateEvent {
    pub channel_id: Uuid,
    pub user_id: Uuid,
    pub muted: bool,
    pub deafened: bool,
}

// ---- rtc.* ---- (relayed verbatim between two participants of the same call)

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct RtcOffer {
    pub channel_id: Uuid,
    pub to: Uuid,
    pub sdp: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct RtcAnswer {
    pub channel_id: Uuid,
    pub to: Uuid,
    pub sdp: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct RtcIce {
    pub channel_id: Uuid,
    pub to: Uuid,
    pub candidate: Value,
}

#[derive(Debug, Deserialize)]
pub struct RtcConnectionState {
    pub channel_id: Uuid,
    pub to: Uuid,
    pub state: String,
}

// ---- stream.* ----

#[derive(Debug, Deserialize)]
pub struct StreamPublish {
    pub channel_id: Uuid,
    pub stream_id: Uuid,
    pub kind: String, // "screen" | "camera"
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub has_audio: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct StreamPublished {
    pub channel_id: Uuid,
    pub stream_id: Uuid,
    pub owner: Uuid,
    pub kind: String,
    pub label: Option<String>,
    pub has_audio: bool,
}

#[derive(Debug, Deserialize)]
pub struct StreamUnpublish {
    pub channel_id: Uuid,
    pub stream_id: Uuid,
}

#[derive(Debug, Serialize, Clone)]
pub struct StreamUnpublished {
    pub channel_id: Uuid,
    pub stream_id: Uuid,
}

#[derive(Debug, Deserialize)]
pub struct StreamSubscribe {
    pub channel_id: Uuid,
    pub stream_id: Uuid,
}

#[derive(Debug, Serialize, Clone)]
pub struct StreamSubscriptionRequested {
    pub channel_id: Uuid,
    pub stream_id: Uuid,
    pub subscriber: Uuid,
}

#[derive(Debug, Deserialize)]
pub struct StreamUnsubscribe {
    pub channel_id: Uuid,
    pub stream_id: Uuid,
}

#[derive(Debug, Serialize, Clone)]
pub struct StreamUnsubscribed {
    pub channel_id: Uuid,
    pub stream_id: Uuid,
    pub subscriber: Uuid,
}

// ---- device.* ----

#[derive(Debug, Deserialize)]
pub struct DeviceListChanged {
    #[serde(default)]
    pub summary: Option<String>,
}
