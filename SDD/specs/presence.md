# Presence — Specification

Status: Draft v1
Owner/Domain: Backend (server/src/presence/*), Client UI (client/ui/src/features/presence)
Related canon sections: §5 (signaling ops), §9 (ID catalog)

## Objetivo

Track and broadcast which community members are currently connected
(online), and their coarse activity state (online/idle/offline), driving the
`MemberSidebar` online/offline grouping and the reconnect banner's "who's
back" implications.

## Contexto

Presence is purely a function of WebSocket connectivity in v1 — there is no
separate "idle" detection beyond a simple client-reported state (no OS-level
idle-time API integration is required for v1; "idle" exists in the data
model/protocol but the v1 client always reports `online` while connected —
see Fora de escopo). A user is "online" the instant their `auth.ok` succeeds
on a WS connection and "offline" the instant that connection closes (with a
short grace period to absorb reconnect flaps, see WS-FR references in
`specs/rtc-signaling.md`'s connect-websocket flow... actually owned by
`flows/connect-websocket.md`).

## Escopo

- Server: in-memory presence registry (`UserId → PresenceState`), keyed off
  the connection registry (one entry per currently-authenticated
  connection; a user can in principle have >1 connection in v1 — e.g. two
  machines — presence is "online" if at least one connection is live).
- `presence.snapshot` (full roster on connect), `presence.update`
  (incremental single-user change broadcast).
- `MemberSidebar` online/offline grouped rendering (dimmed offline list at
  ~0.42 opacity per canon §10).

## Fora de escopo

- Real idle/away detection via OS idle timers — v1 reports only
  `online`/`offline`; the `idle` state value is reserved in the protocol/
  data model for a future client-side idle timer but is never emitted by
  the v1 client (document as a scope cut, not a bug if idle never appears).
- Custom status messages/text (e.g. "Ouvindo música") — future
  consideration only.
- Rich presence (showing "in voice channel X" as a status string) is
  already covered by the voice-channel occupancy rows in `ChannelSidebar`
  (`specs/channels.md`) — presence itself only tracks online/offline, not
  activity detail; the two are visually adjacent in the UI but are
  separate data sources, not merged in the protocol.

## User stories

- As a member, I see in the `MemberSidebar` who else is currently online,
  grouped above an dimmed "Offline" section for everyone else.
- As a member, when someone connects or disconnects, my sidebar updates
  within about a second, without a manual refresh.
- As a member reconnecting after a brief network blip, I don't see everyone
  else flicker offline-then-online in my own view, nor do others see me
  flicker (see Concurrency model's grace period).

## Functional requirements

- **PRES-FR-001**: On `auth.ok` for a connection, if this is the user's
  first currently-live connection (no other live connection for that
  `UserId` already registered), the server marks the user `online` and
  broadcasts `presence.update { user_id, state: "online" }` to all other
  currently-authenticated connections.
- **PRES-FR-002**: Immediately after `auth.ok`, the server sends
  `presence.snapshot { data: { users: [{ user_id, state }] } }` to the
  *newly connected* connection only, listing every community member's
  current state (online members plus, implicitly, all other members as
  `offline` — the snapshot is exhaustive over community membership, not
  just online users, so the client can render the full offline list
  immediately without a separate "all members" fetch; member identity
  details (username/display_name/avatar) are resolved by the client via
  the already-available community member list fetched over REST — see
  `../contracts/rest-api.md` for a `GET /community/members` endpoint if not
  already covered elsewhere; presence itself only carries `user_id` +
  `state`).
- **PRES-FR-003**: When a user's last live connection closes, the server
  waits a short grace window (**PRES-FR-003a**: 8 seconds) before marking
  them `offline` and broadcasting `presence.update { user_id, state:
  "offline" }` — if a new connection from the same `UserId` completes
  `auth.ok` within the grace window, the pending offline transition is
  cancelled silently (no flicker broadcast at all, not even a same-value
  no-op).
- **PRES-FR-004**: A user with ≥2 simultaneous live connections (e.g. two
  devices, or a reconnect race where the old connection hasn't been
  cleaned up yet) is `online` as long as at least one connection is live;
  going from 2→1 live connections is not a state change (no broadcast);
  only 1→0 (with the grace period) triggers the offline transition.
- **PRES-FR-005**: `state` values in v1: `"online"`, `"offline"`. `"idle"`
  is a reserved-but-unused value (protocol/schema allows it for forward
  compatibility; v1 server never emits it, v1 client never sends anything
  that would produce it).
- **PRES-FR-006**: The presence registry is purely in-memory, rebuilt from
  scratch on server restart (every user starts `offline` until they
  reconnect) — never persisted, consistent with canon §6's ephemeral-state
  philosophy for connection-derived state.
- **PRES-FR-007**: `MemberSidebar` groups members into "Online" (sorted
  alphabetically by `display_name`, or by role then alphabetically if role
  badges are shown per canon §10's "OW"/"BLOOD"/"OTZ" badge pattern — v1
  ships role-agnostic alphabetical sort within the Online group, since only
  two roles exist (`owner`/`member`) and no badge-assignment UI exists yet;
  render the owner's badge if present in seed/future data but do not build
  a badge-management UI) above "Offline" (also alphabetical, rendered at
  ~0.42 opacity per canon §10).
- **PRES-FR-008**: A member's presence dot/indicator (small colored circle
  on their avatar, using the palette's green `#5ea88a` for online) updates
  live from `presence.update` without re-fetching the member list.
- **PRES-FR-009**: On WS disconnect from the client's own perspective (see
  `flows/reconnect.md`), the client does not immediately assume everyone
  else went offline — it keeps the last-known presence snapshot rendered
  (dimmed/grey "reconnecting" treatment on the whole sidebar per the
  reconnect banner spec) until a fresh `presence.snapshot` arrives after
  successful reconnection.
- **PRES-FR-010**: The server's own bookkeeping for "which connections
  belong to which user" is the same connection registry used by chat
  broadcast fan-out and call authorization (canon §6's `ConnectionId`
  concept) — presence is a derived view over that registry's liveness, not
  a separate source of truth that could drift from it.
- **PRES-FR-011**: A community member who has never logged in (account
  created via invite but never connected) appears in the Offline group from
  the very first `presence.snapshot` any other client receives — offline is
  the default/rest state for every community member, requiring no special
  "never seen" sub-state.
- **PRES-FR-012**: Presence does not require a heartbeat/ping op distinct
  from the transport-level WebSocket ping/pong (Axum/tungstenite's built-in
  ping-pong keepalive, per `../09-websocket-protocol.md`) — a dead TCP
  connection is detected by that existing keepalive timing out, which then
  triggers the same close-handling path as an explicit disconnect (see
  PRES-FR-003).

## Non-functional requirements

- Presence broadcast fan-out latency: <1s from connection state change to
  all other clients receiving `presence.update`, on a healthy connection
  (same budget class as chat's CHAT-NFR-001, reusing the same broadcast
  plumbing).
- Presence registry operations (mark online/offline, snapshot build) are
  O(community size) — trivially fast at ~10 users, no need for anything
  beyond a `HashMap`.

## UX behavior

- `MemberSidebar` sections: "Online — N" header above the online list,
  "Offline — N" header above the dimmed offline list (counts update live).
- A member coming online: their row moves from Offline to Online (no
  jarring re-sort animation required, but a simple fade/move transition is
  acceptable polish, not a hard requirement).
- Reconnecting banner state (see `flows/reconnect.md`) visually dims/greys
  the entire `MemberSidebar` (not just removes it) to signal "this data may
  be stale" without discarding it.

## UI states

- Member row: online, offline (dimmed ~0.42 opacity per canon §10).
- Sidebar overall: fresh (live data), stale (showing last-known snapshot
  during a reconnect).

## API contracts

None — presence is WS-only in v1 (no REST presence endpoint; the
`presence.snapshot` on connect is the sole "fetch" mechanism). Member
identity metadata (username/display_name/avatar) is sourced from
`specs/channels.md`/community member REST data already loaded, not
duplicated into the presence payload.

## WebSocket events

```
presence.snapshot (S->C, sent once per connection right after auth.ok)
  { users: [{ user_id: uuid, state: "online" | "offline" | "idle" }] }

presence.update (S->C, broadcast on any user's state change)
  { user_id: uuid, state: "online" | "offline" | "idle" }
```
No client→server presence ops exist in v1 (no explicit "set my status"
message — presence is entirely connection-derived).

## IPC contracts

None — presence rides the same WS connection already owned by chat/calls;
no separate native surface.

## Data model

No dedicated table — presence is explicitly NOT persisted (canon §6
philosophy extended here: connection liveness is transient infrastructure
state, not community data). `community_members` (existing table) is the
source of "who counts as a member at all" for building an exhaustive
snapshot including offline members.

## State transitions

Per-user presence state machine: `offline` → `online` (on first live
connection's `auth.ok`) → `offline` (on last live connection closing AND the
8s grace window elapsing without a new connection). No direct
`online`→`idle` or `idle`→anything transition exists in v1 given
PRES-FR-005's reserved-but-unused status.

## Concurrency model

- The connection registry (`HashMap<ConnectionId, ConnState>` plus a
  derived `HashMap<UserId, HashSet<ConnectionId>>` or equivalent) is owned
  by a single async task or protected by a `tokio::sync::RwLock` /
  `DashMap`, consistent with the rest of the WS layer's design in
  `../09-websocket-protocol.md`.
- The 8-second offline grace period is implemented as a `tokio::spawn`ed
  delayed task per (user, connection-closed) event; if a new connection for
  that `UserId` registers before the delayed task fires, the task checks
  "is this user still connection-less" at fire time and no-ops if not —
  no cancellation handle is strictly required (a check-before-broadcast at
  fire time is simpler and equally correct), though an implementation may
  use a `CancellationToken` for efficiency.
- Presence changes are broadcast using the exact same fan-out mechanism as
  `chat.message.created` (iterate live connections), not a separate pub/sub
  system — one broadcast primitive, reused.

## Security considerations

- Presence reveals only `user_id` + coarse online/offline state to other
  authenticated community members — no IP addresses, no device info, no
  location. Acceptable within a trusted 10-person community.
- No unauthenticated access: `presence.snapshot`/`presence.update` only
  ever go to already-`auth.ok`'d connections.

## Failure modes

- Server restart: all users appear offline to everyone until they
  reconnect (expected, not an error state — see Recovery behavior).
- A connection that hangs (half-open TCP, e.g. laptop sleep without a clean
  close) relies on the WS-layer keepalive timeout (per
  `../09-websocket-protocol.md`) to eventually detect and close it, after
  which normal offline handling (with grace period) applies — until that
  timeout fires, the user may appear online while unreachable; this is an
  accepted bound, not a bug, and its exact duration is owned by the
  websocket-protocol doc's ping/pong interval + timeout configuration.

## Recovery behavior

- Client reconnect: on successful re-`auth.ok`, the client always receives
  a fresh `presence.snapshot` and replaces its entire local presence map
  wholesale (never patches/diffs against the stale pre-disconnect map) —
  guarantees no stale entries survive a reconnect regardless of how many
  updates were missed while disconnected.
- Server restart recovery: as connections re-establish (per each client's
  own reconnect backoff, `flows/reconnect.md`), each independently goes
  through the normal `auth.ok` → online-broadcast path; there is no special
  "mass reconnect" batching needed at this community size.

## Telemetry

Server logs online/offline transitions at `debug` (not `info` — this is
high-frequency-ish and low-value for operational monitoring at this scale;
promote to `info` only if diagnosing a specific reconnect-storm issue).

## Testing

- Unit: grace-period cancel-on-reconnect logic; snapshot completeness
  (includes every community member, not just currently-tracked ones).
- Integration: two simulated connections for the same user — closing one
  does not mark the user offline; closing the last one does, after the
  grace period, unless a new connection arrives first; a brand-new
  connection receives a snapshot listing all other members correctly as
  online/offline.
- Manual: kill network briefly (under 8s) and confirm no flicker is
  broadcast to other clients; kill network longer than 8s and confirm
  offline is broadcast, then online again on reconnect.

## Acceptance criteria

- A member's online/offline state is visible to all other members within
  the latency budget above.
- A connection blip shorter than the grace period never produces a visible
  flicker for other members.
- A fresh connection's `presence.snapshot` is a complete, correct picture
  of the whole community's state, not just previously-online users.
- Server restart never leaves a "stuck online" ghost entry (registry is
  rebuilt from nothing, not from a persisted stale store).

## Dependencies

- Connection registry / WS auth handshake from `specs/auth.md`.
- Community membership list from `specs/channels.md` (community
  members REST data) for exhaustive snapshots and for resolving display
  metadata.
- Shared broadcast fan-out mechanism also used by `specs/chat.md`.

## Future considerations

- Real idle detection (OS idle-timer integration) to actually emit `idle`.
- Custom status text.
- Cross-device presence detail (e.g. "online on 2 devices").
