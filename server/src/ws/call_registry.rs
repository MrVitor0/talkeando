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
