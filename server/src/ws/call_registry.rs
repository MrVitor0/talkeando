//! Ephemeral, in-memory-only call/stream state. Never persisted — see
//! SDD/06-backend-architecture.md and SDD/11-call-state-machine.md.
//! Single-process constraint is intentional (see SDD/26-risks-and-tradeoffs.md).

use std::collections::{HashMap, HashSet};

use uuid::Uuid;

use super::protocol::{ParticipantDto, StreamDto, VoiceRosterEntry};

pub type ChannelId = Uuid;
pub type UserId = Uuid;
pub type StreamId = Uuid;

#[derive(Debug, Clone)]
pub struct ParticipantState {
    pub user_id: UserId,
    pub muted: bool,
    pub deafened: bool,
    pub is_bot: bool,
}

impl From<&ParticipantState> for ParticipantDto {
    fn from(p: &ParticipantState) -> Self {
        Self {
            user_id: p.user_id,
            muted: p.muted,
            deafened: p.deafened,
            is_bot: p.is_bot,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PublishedStream {
    pub id: StreamId,
    pub owner: UserId,
    pub kind: String,
    pub label: Option<String>,
    pub has_audio: bool,
    pub msid: Option<String>,
    pub viewers: HashSet<UserId>,
}

impl From<&PublishedStream> for StreamDto {
    fn from(s: &PublishedStream) -> Self {
        Self {
            stream_id: s.id,
            owner: s.owner,
            kind: s.kind.clone(),
            label: s.label.clone(),
            has_audio: s.has_audio,
            msid: s.msid.clone(),
        }
    }
}

#[derive(Debug, Default)]
pub struct ActiveCall {
    pub participants: HashMap<UserId, ParticipantState>,
    pub streams: HashMap<StreamId, PublishedStream>,
}

#[derive(Debug, Default)]
pub struct CallRegistry {
    pub calls: HashMap<ChannelId, ActiveCall>,
}

#[derive(Debug)]
pub enum CallOpError {
    NotInCall,
    CallFull,
    StreamNotFound,
    NotStreamOwner,
    StreamAlreadyPublished,
}

impl CallRegistry {
    /// Applies the authoritative participant lifecycle delivered by LiveKit.
    /// Websocket clients no longer mutate call membership directly.
    pub fn apply_participant(&mut self, channel_id: ChannelId, user_id: UserId, joined: bool) {
        if joined {
            let is_bot = user_id == Uuid::from_u128(1);
            self.calls.entry(channel_id).or_default().participants.entry(user_id).or_insert(ParticipantState { user_id, muted: is_bot, deafened: false, is_bot });
        } else {
            self.leave(channel_id, user_id);
        }
    }

    /// Reflects a participant's camera / screen publications so the community
    /// roster can show who is sharing. Track *media* stays owned by LiveKit;
    /// this only mirrors existence + the publication sid (`msid`) the client
    /// needs to tell a peer's camera feed apart from their screen feed.
    ///
    /// `screen_share_audio` is not its own row — it rides on the screen row as
    /// `has_audio`, and may arrive before or after the screen video publish.
    pub fn apply_track(
        &mut self,
        channel_id: ChannelId,
        user_id: UserId,
        source: &str,
        published: bool,
        track_sid: Option<String>,
    ) {
        let Some(call) = self.calls.get_mut(&channel_id) else { return; };
        let src = source.to_ascii_lowercase();
        let is_screen_audio = src == "screen_share_audio";
        let kind = match src.as_str() {
            "screen_share" | "screen_share_audio" => "screen",
            "camera" => "camera",
            _ => return,
        };
        let existing = call
            .streams
            .values_mut()
            .find(|stream| stream.owner == user_id && stream.kind == kind);
        match (published, is_screen_audio, existing) {
            (true, true, Some(stream)) => stream.has_audio = true,
            (true, true, None) => {
                let id = Uuid::new_v4();
                call.streams.insert(id, PublishedStream { id, owner: user_id, kind: "screen".into(), label: None, has_audio: true, msid: None, viewers: HashSet::new() });
            }
            (true, false, Some(stream)) => {
                if stream.msid.is_none() { stream.msid = track_sid; }
            }
            (true, false, None) => {
                let id = Uuid::new_v4();
                call.streams.insert(id, PublishedStream { id, owner: user_id, kind: kind.into(), label: None, has_audio: false, msid: track_sid, viewers: HashSet::new() });
            }
            (false, true, Some(stream)) => stream.has_audio = false,
            (false, true, None) => {}
            (false, false, _) => {
                let ids: Vec<_> = call.streams.iter().filter(|(_, stream)| stream.owner == user_id && stream.kind == kind).map(|(id, _)| *id).collect();
                for id in ids { call.streams.remove(&id); }
            }
        }
    }

    /// Forces the ephemeral roster to match an authoritative LiveKit snapshot
    /// (see `livekit::room_snapshot`). Only the participant set and each
    /// member's camera / screen publications are touched: per-user mute /
    /// deafen, stream viewer sets, and music (`kind == "music"`) rows keep
    /// their own lifecycle. Returns every channel whose roster or stream set
    /// actually changed so the caller can rebroadcast just those.
    pub fn reconcile(
        &mut self,
        snapshot: Vec<(ChannelId, Vec<ReconcileParticipant>)>,
    ) -> Vec<ChannelId> {
        let mut changed: HashSet<ChannelId> = HashSet::new();
        let live: HashSet<ChannelId> = snapshot.iter().map(|(id, _)| *id).collect();

        // Channels LiveKit no longer reports have no active call.
        let gone: Vec<ChannelId> = self
            .calls
            .keys()
            .copied()
            .filter(|id| !live.contains(id))
            .collect();
        for id in gone {
            self.calls.remove(&id);
            changed.insert(id);
        }

        for (channel_id, participants) in snapshot {
            // A LiveKit room with no participants (briefly, between the last
            // leave and `room_finished`) is not an active call.
            if participants.is_empty() {
                if self.calls.remove(&channel_id).is_some() {
                    changed.insert(channel_id);
                }
                continue;
            }
            let call = self.calls.entry(channel_id).or_default();
            let present: HashSet<UserId> = participants.iter().map(|p| p.user_id).collect();

            // Evict participants (and the streams they owned) LiveKit dropped.
            let stale: Vec<UserId> = call
                .participants
                .keys()
                .copied()
                .filter(|user_id| !present.contains(user_id))
                .collect();
            for user_id in stale {
                call.participants.remove(&user_id);
                let owned: Vec<StreamId> = call
                    .streams
                    .iter()
                    .filter(|(_, stream)| stream.owner == user_id)
                    .map(|(id, _)| *id)
                    .collect();
                for id in owned {
                    call.streams.remove(&id);
                }
                changed.insert(channel_id);
            }

            for participant in participants {
                let is_bot = participant.user_id == Uuid::from_u128(1);
                if !call.participants.contains_key(&participant.user_id) {
                    call.participants.insert(
                        participant.user_id,
                        ParticipantState {
                            user_id: participant.user_id,
                            muted: is_bot,
                            deafened: false,
                            is_bot,
                        },
                    );
                    changed.insert(channel_id);
                }
                if reconcile_stream(call, participant.user_id, "camera", participant.camera_sid, false) {
                    changed.insert(channel_id);
                }
                if participant.screen_sid.is_some() || participant.has_screen_audio {
                    if reconcile_stream(
                        call,
                        participant.user_id,
                        "screen",
                        participant.screen_sid,
                        participant.has_screen_audio,
                    ) {
                        changed.insert(channel_id);
                    }
                } else if remove_owned_stream(call, participant.user_id, "screen") {
                    changed.insert(channel_id);
                }
            }

            if call.participants.is_empty() {
                self.calls.remove(&channel_id);
                changed.insert(channel_id);
            }
        }

        changed.into_iter().collect()
    }

    pub fn clear_channel(&mut self, channel_id: ChannelId) { self.calls.remove(&channel_id); }
    pub fn join(
        &mut self,
        channel_id: ChannelId,
        user_id: UserId,
        muted: bool,
        deafened: bool,
        is_bot: bool,
    ) -> Result<CallSnapshotView, CallOpError> {
        let call = self.calls.entry(channel_id).or_default();
        if !call.participants.contains_key(&user_id) && call.participants.values().filter(|p| !p.is_bot).count() >= 10 {
            return Err(CallOpError::CallFull);
        }
        call.participants.insert(
            user_id,
            ParticipantState {
                user_id,
                muted,
                deafened,
                is_bot,
            },
        );
        Ok(CallSnapshotView {
            participants: call.participants.values().map(Into::into).collect(),
            streams: call.streams.values().map(Into::into).collect(),
        })
    }

    pub fn add_bot(&mut self, channel_id: ChannelId, user_id: UserId) -> bool {
        let call = self.calls.entry(channel_id).or_default();
        if call.participants.contains_key(&user_id) { return false; }
        call.participants.insert(user_id, ParticipantState { user_id, muted: true, deafened: false, is_bot: true });
        true
    }

    /// Removes the participant and any streams they published (a departed
    /// publisher cannot keep a `PublishedStream` alive). Returns the stream
    /// ids that were torn down so callers can broadcast `stream.unpublished`.
    pub fn leave(&mut self, channel_id: ChannelId, user_id: UserId) -> Vec<StreamId> {
        let Some(call) = self.calls.get_mut(&channel_id) else {
            return vec![];
        };
        call.participants.remove(&user_id);
        let owned: Vec<StreamId> = call
            .streams
            .iter()
            .filter(|(_, s)| s.owner == user_id)
            .map(|(id, _)| *id)
            .collect();
        for id in &owned {
            call.streams.remove(id);
        }
        if call.participants.is_empty() {
            self.calls.remove(&channel_id);
        }
        owned
    }

    pub fn is_participant(&self, channel_id: ChannelId, user_id: UserId) -> bool {
        self.calls
            .get(&channel_id)
            .map(|c| c.participants.contains_key(&user_id))
            .unwrap_or(false)
    }

    pub fn is_full(&self, channel_id: ChannelId) -> bool {
        self.calls
            .get(&channel_id)
            .map(|call| call.participants.values().filter(|p| !p.is_bot).count() >= 10)
            .unwrap_or(false)
    }

    pub fn participant_ids(&self, channel_id: ChannelId) -> Vec<UserId> {
        self.calls
            .get(&channel_id)
            .map(|c| c.participants.keys().copied().collect())
            .unwrap_or_default()
    }

    /// Community-visible view of a voice channel: every occupant plus their
    /// mute/deafen state and whether they currently have a live stream. Empty
    /// when the channel has no active call (used to clear a stale sidebar row).
    pub fn roster(&self, channel_id: ChannelId) -> Vec<VoiceRosterEntry> {
        let Some(call) = self.calls.get(&channel_id) else {
            return vec![];
        };
        call.participants
            .values()
            .map(|p| VoiceRosterEntry {
                user_id: p.user_id,
                muted: p.muted,
                deafened: p.deafened,
                sharing: call.streams.values().any(|s| s.owner == p.user_id),
                is_bot: p.is_bot,
            })
            .collect()
    }

    /// The live streams in a channel — pairs with `roster` for the community
    /// broadcast so non-participants can request a hover preview.
    pub fn roster_streams(&self, channel_id: ChannelId) -> Vec<StreamDto> {
        self.calls
            .get(&channel_id)
            .map(|c| c.streams.values().map(Into::into).collect())
            .unwrap_or_default()
    }

    /// True if `user_id` is subscribed to any stream in this channel (they may
    /// be a spectator, not a call participant) — used to authorise RTC relay
    /// between a stream owner and an outside viewer.
    pub fn is_stream_viewer(&self, channel_id: ChannelId, user_id: UserId) -> bool {
        self.calls
            .get(&channel_id)
            .map(|c| c.streams.values().any(|s| s.viewers.contains(&user_id)))
            .unwrap_or(false)
    }

    /// Drops `user_id` from every stream's viewer set across all calls (a
    /// disconnecting spectator). Returns `(channel, stream, owner)` for each
    /// stream affected so the caller can tell owners to stop sending.
    pub fn remove_viewer_globally(
        &mut self,
        user_id: UserId,
    ) -> Vec<(ChannelId, StreamId, UserId)> {
        let mut affected = Vec::new();
        for (channel_id, call) in self.calls.iter_mut() {
            for (stream_id, stream) in call.streams.iter_mut() {
                if stream.viewers.remove(&user_id) {
                    affected.push((*channel_id, *stream_id, stream.owner));
                }
            }
        }
        affected
    }

    /// Channel ids with an active call right now — for the per-connection
    /// voice.rooms snapshot.
    pub fn active_channel_ids(&self) -> Vec<ChannelId> {
        self.calls.keys().copied().collect()
    }

    /// Force-ends a call when its voice channel is deleted. The caller owns
    /// notifying the returned participants; no ephemeral state survives the
    /// channel deletion.
    pub fn terminate(&mut self, channel_id: ChannelId) -> Vec<UserId> {
        self.calls
            .remove(&channel_id)
            .map(|call| call.participants.into_keys().collect())
            .unwrap_or_default()
    }

    pub fn update_participant_state(
        &mut self,
        channel_id: ChannelId,
        user_id: UserId,
        muted: Option<bool>,
        deafened: Option<bool>,
    ) -> Result<ParticipantDto, CallOpError> {
        let call = self.calls.get_mut(&channel_id).ok_or(CallOpError::NotInCall)?;
        let participant = call
            .participants
            .get_mut(&user_id)
            .ok_or(CallOpError::NotInCall)?;
        if let Some(muted) = muted {
            participant.muted = muted;
        }
        if let Some(deafened) = deafened {
            participant.deafened = deafened;
        }
        Ok((&*participant).into())
    }

    pub fn publish(
        &mut self,
        channel_id: ChannelId,
        owner: UserId,
        stream_id: StreamId,
        kind: String,
        label: Option<String>,
        has_audio: bool,
        msid: Option<String>,
    ) -> Result<(), CallOpError> {
        let call = self.calls.get_mut(&channel_id).ok_or(CallOpError::NotInCall)?;
        if !call.participants.contains_key(&owner) {
            return Err(CallOpError::NotInCall);
        }
        if call.streams.contains_key(&stream_id)
            || call.streams.values().any(|stream| stream.owner == owner && stream.kind == kind)
        {
            return Err(CallOpError::StreamAlreadyPublished);
        }
        call.streams.insert(
            stream_id,
            PublishedStream {
                id: stream_id,
                owner,
                kind,
                label,
                has_audio,
                msid,
                viewers: HashSet::new(),
            },
        );
        Ok(())
    }

    /// Removes the stream and returns the viewer set that must be told to
    /// stop expecting media (SUB-FR: 0 viewers <=> 0 sends invariant applies
    /// symmetrically on teardown).
    pub fn unpublish(
        &mut self,
        channel_id: ChannelId,
        owner: UserId,
        stream_id: StreamId,
    ) -> Result<HashSet<UserId>, CallOpError> {
        let call = self.calls.get_mut(&channel_id).ok_or(CallOpError::NotInCall)?;
        let stream = call.streams.get(&stream_id).ok_or(CallOpError::StreamNotFound)?;
        if stream.owner != owner {
            return Err(CallOpError::NotStreamOwner);
        }
        Ok(call.streams.remove(&stream_id).unwrap().viewers)
    }

    /// Records the subscription and returns the stream owner so the caller
    /// can route `stream.subscription_requested` to them. Media only starts
    /// flowing once the owner's client reacts to that message — the
    /// registry itself never moves bytes (SUB-FR-001).
    ///
    /// The subscriber need NOT be a call participant: a community member can
    /// spectate a stream for a hover preview without joining voice. The
    /// handler is responsible for the community-membership check.
    pub fn subscribe(
        &mut self,
        channel_id: ChannelId,
        subscriber: UserId,
        stream_id: StreamId,
    ) -> Result<UserId, CallOpError> {
        let call = self.calls.get_mut(&channel_id).ok_or(CallOpError::NotInCall)?;
        let stream = call
            .streams
            .get_mut(&stream_id)
            .ok_or(CallOpError::StreamNotFound)?;
        stream.viewers.insert(subscriber);
        Ok(stream.owner)
    }

    pub fn unsubscribe(
        &mut self,
        channel_id: ChannelId,
        subscriber: UserId,
        stream_id: StreamId,
    ) -> Result<UserId, CallOpError> {
        let call = self.calls.get_mut(&channel_id).ok_or(CallOpError::NotInCall)?;
        let stream = call
            .streams
            .get_mut(&stream_id)
            .ok_or(CallOpError::StreamNotFound)?;
        stream.viewers.remove(&subscriber);
        Ok(stream.owner)
    }

    pub fn stream_owner(&self, channel_id: ChannelId, stream_id: StreamId) -> Option<UserId> {
        self.calls
            .get(&channel_id)
            .and_then(|c| c.streams.get(&stream_id))
            .map(|s| s.owner)
    }
}

pub struct CallSnapshotView {
    pub participants: Vec<ParticipantDto>,
    pub streams: Vec<StreamDto>,
}

/// One participant of an authoritative LiveKit room snapshot, already
/// resolved to Tupi ids. Fed to `CallRegistry::reconcile`.
pub struct ReconcileParticipant {
    pub user_id: UserId,
    pub camera_sid: Option<String>,
    pub screen_sid: Option<String>,
    pub has_screen_audio: bool,
}

/// Ensures `owner` has exactly one `kind` stream matching `(sid, has_audio)`,
/// creating, updating, or (for a camera with no sid) removing it. Returns
/// whether anything changed. Preserves the row's `viewers` set.
fn reconcile_stream(
    call: &mut ActiveCall,
    owner: UserId,
    kind: &str,
    sid: Option<String>,
    has_audio: bool,
) -> bool {
    if kind == "camera" && sid.is_none() {
        return remove_owned_stream(call, owner, "camera");
    }
    match call
        .streams
        .values_mut()
        .find(|stream| stream.owner == owner && stream.kind == kind)
    {
        Some(stream) => {
            let mut mutated = false;
            if sid.is_some() && stream.msid != sid {
                stream.msid = sid;
                mutated = true;
            }
            if stream.has_audio != has_audio {
                stream.has_audio = has_audio;
                mutated = true;
            }
            mutated
        }
        None => {
            let id = Uuid::new_v4();
            call.streams.insert(
                id,
                PublishedStream {
                    id,
                    owner,
                    kind: kind.to_string(),
                    label: None,
                    has_audio,
                    msid: sid,
                    viewers: HashSet::new(),
                },
            );
            true
        }
    }
}

fn remove_owned_stream(call: &mut ActiveCall, owner: UserId, kind: &str) -> bool {
    let ids: Vec<StreamId> = call
        .streams
        .iter()
        .filter(|(_, stream)| stream.owner == owner && stream.kind == kind)
        .map(|(id, _)| *id)
        .collect();
    let removed = !ids.is_empty();
    for id in ids {
        call.streams.remove(&id);
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uid(n: u128) -> Uuid { Uuid::from_u128(n) }
    fn chan() -> Uuid { Uuid::from_u128(9000) }

    #[test]
    fn reconcile_rebuilds_roster_from_livekit_after_a_wipe() {
        let mut registry = CallRegistry::default();
        // Nothing in memory (server just restarted) but LiveKit still has two
        // people in the room, one of them screen-sharing with audio.
        let changed = registry.reconcile(vec![(
            chan(),
            vec![
                ReconcileParticipant { user_id: uid(1), camera_sid: None, screen_sid: None, has_screen_audio: false },
                ReconcileParticipant { user_id: uid(2), camera_sid: Some("cam2".into()), screen_sid: Some("scr2".into()), has_screen_audio: true },
            ],
        )]);
        assert_eq!(changed, vec![chan()]);
        let roster = registry.roster(chan());
        assert_eq!(roster.len(), 2);
        assert!(roster.iter().find(|e| e.user_id == uid(2)).unwrap().sharing);
        let streams = registry.roster_streams(chan());
        assert!(streams.iter().any(|s| s.owner == uid(2) && s.kind == "camera" && s.msid.as_deref() == Some("cam2")));
        assert!(streams.iter().any(|s| s.owner == uid(2) && s.kind == "screen" && s.has_audio && s.msid.as_deref() == Some("scr2")));
    }

    #[test]
    fn reconcile_preserves_mute_state_and_evicts_absentees() {
        let mut registry = CallRegistry::default();
        registry.join(chan(), uid(1), true, true, false).unwrap();
        registry.join(chan(), uid(2), false, false, false).unwrap();
        // LiveKit now only lists user 1; user 2 left without a webhook.
        let changed = registry.reconcile(vec![(
            chan(),
            vec![ReconcileParticipant { user_id: uid(1), camera_sid: None, screen_sid: None, has_screen_audio: false }],
        )]);
        assert_eq!(changed, vec![chan()]);
        let roster = registry.roster(chan());
        assert_eq!(roster.len(), 1);
        let entry = &roster[0];
        assert_eq!(entry.user_id, uid(1));
        assert!(entry.muted && entry.deafened, "existing mute/deafen must survive a reconcile");
    }

    #[test]
    fn reconcile_drops_channels_livekit_no_longer_reports() {
        let mut registry = CallRegistry::default();
        registry.join(chan(), uid(1), false, false, false).unwrap();
        let changed = registry.reconcile(vec![]);
        assert_eq!(changed, vec![chan()]);
        assert!(registry.roster(chan()).is_empty());
        assert!(registry.active_channel_ids().is_empty());
    }

    #[test]
    fn reconcile_is_a_noop_when_already_in_sync() {
        let mut registry = CallRegistry::default();
        registry.join(chan(), uid(1), false, false, false).unwrap();
        let snapshot = vec![(
            chan(),
            vec![ReconcileParticipant { user_id: uid(1), camera_sid: None, screen_sid: None, has_screen_audio: false }],
        )];
        assert!(registry.reconcile(snapshot).is_empty());
    }
}
