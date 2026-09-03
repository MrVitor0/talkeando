//! Projects the v2 `VoiceRegistry` onto the shape v1 clients expect
//! (`voice.roster` / `voice.rooms`). Contract: tupi-v2-refactor/05-protocol-spec.md
//! §6. Removed once no v1 clients remain (SPEC-018).

use std::collections::BTreeMap;

use uuid::Uuid;

use crate::ws::{
    protocol::{StreamDto, VoiceRoomDto, VoiceRosterEntry},
    voice_registry::{TrackSource, VoiceRegistry, VoiceRoom},
};

/// v2 snapshot of one room, sorted deterministically. `None` if the channel
/// has no room.
pub fn v2_room(voice: &VoiceRegistry, channel_id: Uuid) -> Option<VoiceRoomDto> {
    voice.room(channel_id).map(|room| room.to_dto(channel_id))
}

/// Fixed namespace for v1 `stream_id` UUID v5s. DO NOT CHANGE: changing it
/// makes every v1 client treat existing shares as new ones.
const STREAM_NAMESPACE: Uuid = Uuid::from_u128(0x6f0c2f8c_8e40_4a3e_9d2f_1c0a1b2c3d4e);

/// `(roster entries, streams)` for one channel, sorted deterministically.
pub fn v1_roster(voice: &VoiceRegistry, channel_id: Uuid) -> (Vec<VoiceRosterEntry>, Vec<StreamDto>) {
    let Some(room) = voice.room(channel_id) else {
        return (Vec::new(), Vec::new());
    };
    let streams = v1_streams(room, channel_id);
    let mut participants: Vec<VoiceRosterEntry> = room
        .participants
        .values()
        .map(|p| VoiceRosterEntry {
            user_id: p.user_id,
            muted: p.muted,
            deafened: p.deafened,
            sharing: streams.iter().any(|s| s.owner == p.user_id),
            is_bot: p.is_bot,
        })
        .collect();
    participants.sort_by_key(|entry| entry.user_id);
    (participants, streams)
}

/// Groups a room's tracks by `(owner, kind)` — `screen_share` and
/// `screen_share_audio` collapse into `"screen"`, `camera` into `"camera"`,
/// `music` into `"music"`, `microphone` is not a stream. `stream_id` is a
/// deterministic UUID v5 of `(channel_id, owner, kind)`.
fn v1_streams(room: &VoiceRoom, channel_id: Uuid) -> Vec<StreamDto> {
    struct Group {
        video_sid: Option<String>,
        has_screen_audio: bool,
    }
    let mut groups: BTreeMap<(Uuid, &'static str), Group> = BTreeMap::new();

    for track in room.tracks.values() {
        let kind = match track.source {
            TrackSource::ScreenShare | TrackSource::ScreenShareAudio => "screen",
            TrackSource::Camera => "camera",
            TrackSource::Music => "music",
            TrackSource::Microphone => continue,
        };
        let group = groups
            .entry((track.owner, kind))
            .or_insert(Group { video_sid: None, has_screen_audio: false });
        match track.source {
            TrackSource::ScreenShare | TrackSource::Camera => {
                group.video_sid = Some(track.sid.clone());
            }
            TrackSource::ScreenShareAudio => group.has_screen_audio = true,
            _ => {}
        }
    }

    let mut streams: Vec<StreamDto> = groups
        .into_iter()
        .map(|((owner, kind), group)| StreamDto {
            stream_id: Uuid::new_v5(
                &STREAM_NAMESPACE,
                format!("{channel_id}:{owner}:{kind}").as_bytes(),
            ),
            owner,
            kind: kind.to_string(),
            label: None,
            has_audio: kind == "music" || group.has_screen_audio,
            msid: group.video_sid,
        })
        .collect();
    streams.sort_by_key(|s| s.stream_id);
    streams
}
