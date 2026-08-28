//! Wire format for the Tupi signaling/chat/presence WebSocket protocol.
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

/// Inbound `presence.set` — a member toggling their own status. v1 accepts
/// `"online"` and `"busy"` (DND); `"busy"` also silences their own
/// new-message notifications, which is a client-side effect.
#[derive(Debug, Deserialize)]
pub struct PresenceSet {
    pub status: String,
}

// ---- activity.* ----
// Ephemeral "rich presence": what a member is playing/listening to outside
// Tupi. Client-detected (native SMTC / process scan), never persisted.
// Catalog: SDD/specs/activity.md.

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Activity {
    pub kind: String, // "playing" | "listening" | "watching" | "browsing"
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>, // RFC3339, opaque to the server
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_image: Option<String>, // opaque ref resolved by the UI ("steam:<appid>", "att:<hash>", URL)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_text: Option<String>,

    // ---- server-derived, outbound only (ACT-FR-032). Clients never set
    // these; `sanitize` forces them to None on the way in, and the aggregate
    // step fills them for `kind == "playing"` on the way out. ----
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_seconds: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_played_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_new: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct ActivityReport {
    #[serde(default)]
    pub activities: Vec<Activity>,
    #[serde(default)]
    #[allow(dead_code)]
    pub req_id: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ActivityEntry {
    pub user_id: Uuid,
    pub activities: Vec<Activity>,
}

#[derive(Debug, Serialize)]
pub struct ActivitySnapshot {
    pub users: Vec<ActivityEntry>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ActivityUpdate {
    pub user_id: Uuid,
    pub activities: Vec<Activity>,
}

// ---- member.updated / channel.updated ----
// Outbound-only community broadcasts for the lightweight "right-click to
// rename" edits (display name, avatar, channel name). No inbound op — the
// mutations land over REST (routes/profile.rs, routes/channels.rs) and the
// resulting row is fanned out here so every client's sidebar/roster stays
// live without a refetch.

#[derive(Debug, Serialize)]
pub struct MemberUpdated {
    pub user_id: Uuid,
    pub display_name: String,
    /// `/api/users/<id>/avatar` when the member has one, else `None`. The
    /// native host inlines this to a `data:` URI before it reaches the UI
    /// (IpcBridge.HandleNetworkEvent), same as it does for bootstrap avatars.
    pub avatar_url: Option<String>,
    pub avatar_color: Option<String>,
    pub profile_tag: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ChannelUpdated {
    pub id: Uuid,
    pub name: String,
    pub kind: String,
    pub category_id: Option<Uuid>,
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
    #[serde(default)]
    pub is_bot: bool,
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
    #[serde(default)]
    pub is_bot: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct CallStateUpdateEvent {
    pub channel_id: Uuid,
    pub user_id: Uuid,
    pub muted: bool,
    pub deafened: bool,
}

// ---- voice.roster / voice.rooms ----
// Community-wide, low-frequency projection of who is in each voice channel so
// the sidebar can render occupants live even for channels the viewer has not
// joined. Distinct from call.* (which is scoped to a call's own participants).

#[derive(Debug, Serialize, Clone)]
pub struct VoiceRosterEntry {
    pub user_id: Uuid,
    pub muted: bool,
    pub deafened: bool,
    pub sharing: bool,
    #[serde(default)]
    pub is_bot: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct VoiceRoster {
    pub channel_id: Uuid,
    pub participants: Vec<VoiceRosterEntry>,
    /// Live streams in this channel, so a member who has *not* joined can still
    /// request a hover preview (spectator subscribe — see handler.rs).
    pub streams: Vec<StreamDto>,
}

#[derive(Debug, Serialize, Clone)]
pub struct VoiceRoomsSnapshot {
    pub rooms: Vec<VoiceRoster>,
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

// ---- music.* ---- Local-DJ control plane. Playback is never proxied by the
// server; this just selects the client that owns the WebRTC music track.
#[derive(Debug, Deserialize, Clone)]
pub struct MusicCommand {
    pub channel_id: Uuid, // chat channel where the bot replies
    pub voice_channel_id: Uuid,
    pub command: String, // play | pause | resume | skip | stop | queue
    #[serde(default)]
    pub query: Option<String>,
}

// ---- device.* ----

#[derive(Debug, Deserialize)]
pub struct DeviceListChanged {
    #[serde(default)]
    pub summary: Option<String>,
}
