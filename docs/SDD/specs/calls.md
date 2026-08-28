# Calls — Specification

Status: Draft v1
Owner/Domain: Backend (server/src/calls/*), Client native (client/native/*/Rtc), Client UI (client/ui/src/features/voice)
Related canon sections: §3 (RTC architecture), §5 (signaling ops), §6 (call state), §9 (ID catalog)

## Objetivo

Define the call lifecycle: joining/leaving a voice channel, the ephemeral
server-side `ActiveCall` registry that authorizes all signaling, and the
`VoiceStatusPanel`/roster UX around being "in a call." This spec owns
join/leave semantics and call membership; `specs/rtc-signaling.md` owns the
actual peer connection negotiation (offer/answer/ICE) that calls trigger.

## Contexto

Voice is mesh P2P, control-plane-only on the server (canon §3). A "call" is
1:1 with a voice channel: joining channel X's call means joining the
`ActiveCall` keyed by that `ChannelId`. There is no separate "call" entity
independent of a voice channel — you cannot have two simultaneous calls in
the same channel, and a user can be an active participant in at most one
call at a time (joining a second one implicitly leaves the first, matching
Discord-like single-voice-channel-at-a-time behavior).

## Escopo

- `call.join` / `call.snapshot` / `call.peer_joined`
- `call.leave` / `call.peer_left`
- Server-side `CallRegistry`/`ActiveCall`/`ParticipantState` per canon §6
- Mute/deafen state (participant-level flags, server-authorized broadcast)
- `VoiceStatusPanel` (bottom of `ChannelSidebar`): connected-channel
  indicator, mute/deafen/settings, quick action grid
- Single-voice-channel-at-a-time enforcement (auto-leave on join elsewhere)
- Call teardown when the last participant leaves

## Fora de escopo

- The actual WebRTC offer/answer/ICE exchange triggered by joining — see
  `specs/rtc-signaling.md`.
- Screen share / camera streams layered onto a call — see
  `specs/screen-share.md`, `specs/camera.md`, `specs/subscriptions.md`.
- Adaptive quality control — see `specs/audio.md` (audio-specific) and the
  future `21-quality-adaptation.md` (owned elsewhere) for QUAL-FR items.
- Call recording, transcription.
- Voice activity detection UI (speaking indicator) is IN scope minimally
  (see Functional requirements) but its underlying audio-level detection
  mechanism is owned by `specs/audio.md`.

## User stories

- As a member, I click a voice channel row and join its call; I immediately
  see who else is there and they see me appear.
- As a member already in voice channel A, clicking voice channel B moves me
  there directly (A shows me as departed, B shows me as joined) without an
  extra "leave first" step.
- As a member, I can mute my mic or deafen (mute mic + stop playing others)
  from the `VoiceStatusPanel`, and other participants see my mute/deafen
  state reflected in the roster.
- As a member, clicking "leave call" (or closing the app) cleanly removes me
  from the roster for everyone else.
- As the last person in a call, leaving tears down the `ActiveCall` entirely
  (no ghost empty calls lingering in server memory).

## Functional requirements

- **CALL-FR-001**: `call.join` (C→S): `{ req_id, channel_id }`. Server
  validates: `channel_id` exists, `kind == "voice"`, sender is a community
  member. If the sender already has a `ParticipantState` in a *different*
  channel's `ActiveCall`, the server first performs an implicit
  `call.leave` for that old channel (per CALL-FR-007's broadcast rules)
  before proceeding with the join — this is transparent to the client (the
  client does NOT need to send an explicit `call.leave` before joining a
  new channel; the client SHOULD still update its own local UI to "leaving
  A" immediately for responsiveness, but the server is the source of truth
  and performs the leave regardless of client behavior).
- **CALL-FR-002**: On successful join, server inserts/updates the
  `ActiveCall` for that `channel_id` (creating it if this is the first
  participant) with a new `ParticipantState { user_id, joined_at: now(),
  muted: <client-declared initial state, default false>, deafened: <same,
  default false>, connection_id }`.
- **CALL-FR-003**: Server replies to the joining connection with
  `call.snapshot { data: { channel_id, participants: [ParticipantSummary],
  streams: [PublishedStreamSummary], in_reply_to: req_id } }` —
  `participants` includes every current participant (including the joiner
  themself, listed for UI consistency) with `{ user_id, muted, deafened,
  joined_at }`; `streams` includes every currently-published stream in that
  call per `specs/subscriptions.md` (empty array if none).
- **CALL-FR-004**: Server broadcasts `call.peer_joined { channel_id,
  participant: ParticipantSummary }` to every *other* participant already
  in that call (not to the joiner, who got the full snapshot instead; not
  to the rest of the community outside the call — only existing call
  members need this event, since only they hold PeerConnections that must
  now negotiate with the new peer).
- **CALL-FR-005**: `call.leave` (C→S): `{ req_id, channel_id }` (channel_id
  is included for validation/idempotency even though a user is in at most
  one call — server checks it matches their actual current call, returning
  `error { code: "not_in_call" }` if it doesn't match or they're not in
  any call). Removes their `ParticipantState` from the `ActiveCall`.
- **CALL-FR-006**: Server acks the leaver directly (no dedicated
  `call.left`-to-self event beyond the generic ack pattern — reuse an
  implicit success by the absence of an error, OR emit `call.peer_left`
  to the leaver too for symmetry: **decision** — the leaver also receives
  `call.peer_left { channel_id, user_id: <self> }` as its "did I leave"
  confirmation, so client logic is uniform: every participant, including
  the one who just left, reacts to `call.peer_left` by tearing down that
  specific peer's UI/connection state; the leaver's client additionally
  knows "that was me" by comparing `user_id` to its own and tears down the
  *entire* call UI, not just one peer tile, when it matches self).
- **CALL-FR-007**: Server broadcasts `call.peer_left { channel_id, user_id,
  reason: "left" | "disconnected" | "channel_deleted" }` to every remaining
  participant in that call (and, per CALL-FR-006, to the leaver themself
  when `reason: "left"`).
- **CALL-FR-008**: If the departing participant was the last one in the
  `ActiveCall`, the server deletes the `ActiveCall` entry entirely from the
  `CallRegistry` (including any `PublishedStream`s it held — see
  `specs/subscriptions.md`'s teardown rules) — no empty calls persist in
  memory.
- **CALL-FR-009**: Losing the underlying WebSocket connection (network
  drop, app crash, clean close) while a participant is in a call is treated
  as an implicit `call.leave` with `reason: "disconnected"`, applied
  immediately (no grace period distinct from presence's — call membership
  and presence are separate concerns; a call-leave-on-disconnect happens
  right away since a dead WS connection cannot carry any further
  signaling for that peer relationship regardless, whereas presence's 8s
  grace period is purely a UI-flicker optimization for the member list).
  Note this differs from `flows/reconnect.md`'s WebSocket-reconnect layer:
  if the client reconnects quickly, it must explicitly re-`call.join` (the
  server does not "hold a slot" for a disconnected participant) — see
  `flows/reconnect.md` for the full rejoin sequence and its interaction
  with WebRTC-layer ICE-restart reconnection, which is a *different*,
  faster-acting recovery path than a full call rejoin.
- **CALL-FR-010**: `call.mute` / `call.deafen` are NOT separate WS ops in
  v1 — mute/deafen state changes ride as an update within `call.join`'s
  initial declaration (CALL-FR-002) plus a dedicated lightweight op:
  `call.state.update (C→S) { req_id, channel_id, muted?: bool, deafened?:
  bool }` (either field optional, only present fields change) → server
  updates the caller's `ParticipantState` and broadcasts
  `call.state.update (S→C) { channel_id, user_id, muted, deafened }`
  (full resulting state, not just the changed field, to keep client
  reducers simple) to all other participants in that call. (This op name
  is additive to canon §5's literal catalog — canon's catalog lists the
  `call.*`/`rtc.*`/`stream.*` namespaces but does not enumerate every
  sub-op explicitly for mute/deafen; this spec fills that gap consistently
  with the catalog's spirit and naming convention. If the other writer's
  `09-websocket-protocol.md` needs a literal op list, it must include this
  one verbatim: `call.state.update`.)
- **CALL-FR-011**: Deafening implies muting at the UX layer (client sets
  both `muted: true, deafened: true` when the user deafens, and restores
  the user's prior mute preference when un-deafening) but the server does
  not enforce this coupling — it stores whatever combination the client
  sends, since deafen-without-mute is a valid (if unusual) state some UIs
  allow explicitly.
- **CALL-FR-012**: A voice channel row in `ChannelSidebar` (per
  `specs/channels.md`) and the `VoiceStatusPanel` both derive their
  "who's in this call" display from the same `call.snapshot` /
  `call.peer_joined` / `call.peer_left` / `call.state.update` event stream
  — there is exactly one client-side store for call/roster state, read by
  multiple components.
- **CALL-FR-013**: Speaking indicator (visual "this person is talking"
  ring/glow on their avatar) is driven by local WebRTC audio-level
  measurement per remote track (see `specs/audio.md`), NOT by a
  server-relayed signaling op — it is a purely client-local, per-peer-
  connection computation, so it has no `call.*` WS event of its own.
- **CALL-FR-014**: Joining a call that has reached the informal 10-person
  community size is never rejected for "capacity" reasons in v1 (matches
  CHAN-FR-009 — the community itself is capped at ~10 members by invite
  scarcity, not by an enforced join-time capacity check on the call).
- **CALL-FR-015**: `call.snapshot`'s `participants` list ordering: by
  `joined_at` ascending (stable, so UI doesn't reorder existing tiles when
  a new participant is appended — new joiners always render at the end of
  the roster).
- **CALL-FR-016**: All `call.*` and downstream `rtc.*`/`stream.*` messages
  are authorized against the `CallRegistry` per canon §6: sender must
  actually hold a `ParticipantState` in the referenced call for any op that
  isn't `call.join` itself; violations return `error { code:
  "not_in_call" }` and are logged at `warn` (should never happen from a
  correct client — indicates either a bug or a stale/racy client state).

## Non-functional requirements

- `call.join` → `call.snapshot` round trip: <200ms p95 (pure in-memory
  registry operation, no DB I/O on the join path).
- `call.peer_joined`/`call.peer_left` fan-out to existing participants:
  <300ms p95, since this gates how quickly the mesh can start ICE
  negotiation with a new peer (see `flows/join-call.md`).
- Server must sustain the worst-case v1 mesh size (10 participants ⇒ 45
  pairwise PeerConnections across the mesh) purely as control-plane
  message routing — no media touches the server, so this is a trivial
  load, but the fan-out loop must be O(participants) per event, not
  O(participants²) server-side (each event is one broadcast loop; the
  O(n²) cost lives entirely in the clients' mesh of PeerConnections, which
  is expected and accepted per canon §3).

## UX behavior

- Clicking a voice channel row while not in any call: immediately shows a
  "Conectando…" transient state on that row/the `VoiceStatusPanel`, then
  transitions to connected once `call.snapshot` arrives and at least the
  local audio pipeline is ready (does not wait for remote peer connections
  to finish negotiating — see `flows/join-call.md` for exact ordering
  against `specs/audio.md`'s mic acquisition).
- Clicking a different voice channel while already in one: no confirmation
  dialog (matches CALL-FR-001's transparent implicit leave) — the UI
  immediately reflects "left A, joining B."
- `VoiceStatusPanel` shows: current channel name, a compact roster (avatar
  row), mute toggle, deafen toggle, a settings gear (opens
  `specs/settings.md`'s device panel), and a "Desconectar" (disconnect)
  action.
- Per-peer connecting state: an individual participant tile can show a
  brief "conectando áudio…" micro-state between `call.peer_joined`/being
  listed in `call.snapshot` and the underlying PeerConnection reaching
  `connected` (see `specs/rtc-signaling.md`) — this is a per-peer, not
  per-call, loading state.
- Mute/deafen toggles reflect optimistically (instant local visual
  feedback) and reconcile against the server broadcast echo, same
  optimistic pattern as chat (see `specs/chat.md` CHAT-FR-010) but simpler
  since mute/deafen failures are not user-actionable beyond "try again" (no
  dedicated failed-state UI needed given how rarely this op fails absent a
  full disconnect).

## UI states

- Not in any call.
- Joining (per-call transient).
- In call: normal, muted (self), deafened (self), per-peer connecting,
  per-peer connected, per-peer speaking (see `specs/audio.md`).
- Leaving/disconnecting (brief transient on explicit leave).

## API contracts

None — calls are entirely WS-driven, no REST surface (matches canon §6's
"ephemeral, never persisted" call state).

## WebSocket events

```
call.join (C->S)   { req_id, channel_id }
call.snapshot (S->C, to joiner) {
  channel_id,
  participants: [{ user_id, muted, deafened, joined_at }],
  streams: [PublishedStreamSummary],   // see specs/subscriptions.md
  in_reply_to: req_id
}
call.peer_joined (S->C, broadcast to other existing participants) {
  channel_id, participant: { user_id, muted, deafened, joined_at }
}

call.leave (C->S)  { req_id, channel_id }
call.peer_left (S->C, broadcast to all remaining participants + the leaver) {
  channel_id, user_id, reason: "left" | "disconnected" | "channel_deleted"
}

call.state.update (C->S)  { req_id, channel_id, muted?: bool, deafened?: bool }
call.state.update (S->C, broadcast to other participants) {
  channel_id, user_id, muted: bool, deafened: bool
}
```
Errors: `error { code: "channel_not_found" | "wrong_channel_kind" |
"not_in_call", in_reply_to }`.

## IPC contracts

- UI→Native: none directly for join/leave (signaling rides the JS-owned WS
  connection per `specs/auth.md`'s IPC note) — but the *result* of a join
  (need to acquire mic, create PeerConnections) is coordinated with the
  native RTC layer via IPC ops owned by `specs/rtc-signaling.md` and
  `specs/audio.md` (e.g. `rtc.peer.create`, `audio.capture.start`). This
  spec only asserts the ordering constraint: the UI sends `call.join` over
  WS and, upon receiving `call.snapshot`, immediately instructs the native
  layer (via IPC) to create `PeerController`s for every listed participant
  and start local audio capture — see `flows/join-call.md` for the exact
  interleaving.

## Data model

None persisted — `CallRegistry`/`ActiveCall`/`ParticipantState` exactly as
canon §6 defines them, in-process memory only, rebuilt empty on every
server restart.

## State transitions

Per-call: `nonexistent` → `active` (first `call.join`) → `active` (steady
state, participants come and go) → `nonexistent` (last participant leaves,
CALL-FR-008). Per-participant: `not_in_call` → `in_call` → `not_in_call`
(explicit leave, implicit leave via joining elsewhere, or disconnect).

## Concurrency model

- `CallRegistry` is a single shared structure (e.g.
  `Arc<RwLock<HashMap<ChannelId, ActiveCall>>>` or an actor task owning it
  exclusively) — canon §6 requires every signaling message to be authorized
  against it, so reads (authorization checks) must be cheap/frequent and
  writes (join/leave/state-update) must be serialized per-channel at
  minimum. Recommended implementation: one `ActiveCall` per channel behind
  its own lock (or one actor per active call, spawned on first join and
  torn down on last leave) so that unrelated calls never contend with each
  other; a top-level `RwLock` or `DashMap` protects only the
  `HashMap<ChannelId, ActiveCall>` structure itself (insert/remove of whole
  calls), not the frequent per-call participant churn.
- The implicit-leave-then-join sequence (CALL-FR-001) must be atomic from
  the affected user's perspective — no window where authorization checks
  against `CallRegistry` see them as "in both calls" or "in neither call";
  implement as: acquire both calls' locks (old then new, consistent
  ordering by `ChannelId` to avoid deadlock) or, if using the single-actor-
  per-call model, sequence the leave's completion before the join begins
  by routing both through one coordinating task.

## Security considerations

- Every `call.*`/`rtc.*`/`stream.*` message is authorized against actual
  `ParticipantState` membership (CALL-FR-016) — a user cannot spoof
  `call.peer_left` for someone else, cannot join a call and inject
  `rtc.offer`/`stream.*` messages to peers in a call they're not part of.
- `user_id` in all payloads is always the server-authenticated identity of
  the sender (from the WS connection's session), never client-supplied.

## Failure modes

- `call.join` for a nonexistent/deleted channel: `error {
  channel_not_found }`.
- `call.join` for a text channel: `error { wrong_channel_kind }`.
- `call.leave`/`call.state.update` when not actually in that call: `error {
  not_in_call }`.
- Channel deleted while a call is active (`specs/channels.md` CHAN-FR-007):
  server force-ends the call, broadcasting `call.peer_left { reason:
  "channel_deleted" }` to every participant before the channel row is
  removed.

## Recovery behavior

See `flows/reconnect.md` for the full three-layer recovery story
(WebSocket reconnect / ICE restart / full call rejoin). This spec's
contribution: a client detecting its WebSocket dropped while it believed
itself "in a call" must, upon successful WS reconnection, explicitly send
a fresh `call.join` for that channel (the server never remembers a
disconnected participant, per CALL-FR-009) and must be prepared for
`call.snapshot` to come back with a roster that no longer matches its
stale pre-disconnect belief (other participants may have joined/left
during the gap) — the client discards its stale roster wholesale and
rebuilds from the fresh snapshot, exactly mirroring presence's
reconnect-replaces-wholesale rule (`specs/presence.md`).

## Telemetry

Server logs `info`: call created (first join), call destroyed (last
leave), participant join/leave with reason. `call.state.update` logged at
`debug` only (frequent, low operational value). All logs include
`channel_id`/`user_id`, never audio/media content (there is none at this
layer).

## Testing

- Unit: implicit-leave-then-join sequencing; last-participant teardown;
  ordering of `participants` in snapshot.
- Integration: two/three simulated connections join the same channel,
  verify snapshot completeness and peer_joined fan-out excludes the
  joiner; leave broadcasts to remaining participants and to the leaver;
  joining channel B while in channel A produces both the A-leave and
  B-join events in the correct order for all affected connections;
  disconnect (drop socket) is treated as leave with `reason:
  "disconnected"`; channel deletion mid-call force-ends it.
- Manual/E2E: full 4-person mesh join/leave via `flows/join-call.md` and
  `flows/leave-call.md`; verify `VoiceStatusPanel` and `ChannelSidebar`
  occupancy stay consistent with the same underlying event stream.

## Acceptance criteria

- A user can be an active participant in at most one call at any time,
  enforced server-side, not just by client discipline.
- Joining a new voice channel while already in one produces a clean,
  correctly-ordered leave-then-join for all observers, with no window of
  double-membership.
- The last participant leaving a call fully removes all server-side state
  for it (verified by checking the registry/logs show no lingering
  `ActiveCall`).
- All call-scoped signaling correctly rejects senders/targets not actually
  in that call.

## Dependencies

- `specs/channels.md` for channel existence/kind checks and the
  `ChannelSidebar` occupancy rows this feeds.
- `specs/rtc-signaling.md` for what happens after `call.peer_joined`
  (offer/answer/ICE).
- `specs/audio.md` for mute/deafen's actual media-layer effect and speaking
  detection.
- `specs/subscriptions.md` for `streams` in `call.snapshot`.
- `flows/join-call.md`, `flows/leave-call.md`, `flows/reconnect.md`.

## Future considerations

- Server-relayed "typing"-like voice activity op if client-local detection
  proves insufficient (e.g. for a future notification like "X started
  talking").
- Push-to-talk as an alternative to open-mic/toggle-mute (client-local
  feature, no protocol change anticipated).
- Call size limits if the community size assumption ever changes.
