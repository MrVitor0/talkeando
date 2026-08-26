# RTC Signaling — Specification

Status: Draft v1
Owner/Domain: Backend (server/src/rtc/* — pure relay, no media), Client native (client/native/*/Rtc/PeerController)
Related canon sections: §3 (RTC architecture, perfect negotiation), §5 (rtc.* ops), §6 (call state), §9 (ID catalog)

## Objetivo

Specify the WebRTC peer connection lifecycle for voice mesh calls: how
offer/answer/ICE candidates are exchanged via the server-as-relay, the
Perfect Negotiation pattern that avoids glare, the `PeerController` actor
that owns each `RTCPeerConnection`, TURN credential issuance, and ICE
restart recovery.

## Contexto

Per canon §3, there is no SFU — every pair of call participants holds a
direct `RTCPeerConnection` (SIPSorcery), and the server's only role is
relaying `rtc.offer`/`rtc.answer`/`rtc.ice` messages between the correct
`from_user`/`to_user` pair, both validated as active participants of the
same call. Screen share and camera tracks ride these same PeerConnections
(no new PeerConnection per stream — see `specs/subscriptions.md`), which is
why renegotiation (not just initial offer/answer) is a first-class,
frequent event in this design, and why Perfect Negotiation (rather than a
simpler "always-impolite-caller" pattern) is required: either side of an
existing connection can independently trigger a renegotiation (e.g. peer A
subscribing to peer B's stream while peer B simultaneously subscribes to
peer A's) and both must converge without colliding.

## Escopo

- `rtc.offer` / `rtc.answer` / `rtc.ice` relay semantics and authorization
- Perfect Negotiation roles (polite/impolite) and glare handling
- `PeerController` actor: one per remote peer, single serialized command
  queue, sole owner of its `RTCPeerConnection`
- Initial connection establishment when a call is joined (mesh formation)
- ICE restart (network change recovery)
- TURN credential issuance (short-lived HMAC-based)
- `rtc.connection_state` diagnostic telemetry op

## Fora de escopo

- What triggers a renegotiation (stream subscribe/unsubscribe) — see
  `specs/subscriptions.md`, `specs/screen-share.md`, `specs/camera.md`.
- Call join/leave semantics — see `specs/calls.md`.
- Audio capture/render specifics — see `specs/audio.md`.
- Adaptive bitrate/quality control — future `21-quality-adaptation.md`.
- SFU/relay media path — explicitly not built (canon §3).

## User stories

- As a user joining a call with 3 existing participants, my client
  automatically establishes 3 PeerConnections without any user-visible
  negotiation step — I just see peers appear as "connecting" then
  "connected."
- As a user whose Wi-Fi drops and reconnects to a different network, my
  existing call peers recover via ICE restart without me having to rejoin
  the call or lose the other participants' audio for more than a brief
  blip.
- As a developer, I can reason about exactly one peer relationship at a
  time without worrying about race conditions, because each peer
  relationship is owned by a single serialized actor.

## Functional requirements

- **RTC-FR-001**: Roles are assigned deterministically per peer pair by
  comparing `UserId` (UUID) values: the peer with the lexicographically
  lower UUID string is "polite," the other is "impolite" (canon §3). Both
  sides compute this locally and independently — no negotiation-of-roles
  message is needed; it is a pure function of the two known UUIDs.
- **RTC-FR-002**: On `call.peer_joined` (existing participant's view) or on
  receiving `call.snapshot` (new joiner's view, one entry per existing
  participant), the client creates one `PeerController` per newly-known
  peer, each wrapping a fresh SIPSorcery `RTCPeerConnection` configured
  with the ICE server list (STUN + TURN, see RTC-FR-014).
- **RTC-FR-003**: The **impolite** peer in each newly-formed pair is
  responsible for creating the initial offer (calls
  `createOffer`/`setLocalDescription` then sends `rtc.offer`); the
  **polite** peer waits to receive it. This avoids both sides racing to
  offer on initial connection, the simplest form of glare.
- **RTC-FR-004**: `rtc.offer` (C→S, routed): `{ req_id, to_user: uuid, sdp:
  string }`. Server validates `from_user` (the authenticated sender) and
  `to_user` are both current participants of the *same* `ActiveCall`
  (looked up via the `CallRegistry`, canon §6); if not, replies `error {
  code: "not_in_same_call", in_reply_to }` to the sender only. On success,
  forwards verbatim to `to_user`'s connection as `rtc.offer (S→C) {
  from_user, sdp }` (no `req_id` echo to the recipient — it's a fresh
  inbound event to them, not a reply).
- **RTC-FR-005**: `rtc.answer` (C→S, routed): `{ req_id, to_user, sdp }` —
  identical relay/authorization semantics to `rtc.offer`, forwarded as
  `rtc.answer (S→C) { from_user, sdp }`.
- **RTC-FR-006**: `rtc.ice` (C→S, routed): `{ req_id, to_user, candidate:
  RTCIceCandidateInit }` — same relay/authorization semantics, forwarded as
  `rtc.ice (S→C) { from_user, candidate }`. Candidates may arrive before or
  after the remote description is set on the receiving side; the
  `PeerController` buffers/queues early candidates and applies them once
  `setRemoteDescription` has completed (standard trickle-ICE handling).
- **RTC-FR-007**: The server performs zero SDP/ICE inspection or
  modification beyond the authorization check — it is a byte-transparent
  relay (canon §3 "server is control-plane only, never touches media
  bytes," extended here to mean it doesn't even parse SDP content, only
  routes based on the envelope's `to_user`/`from_user`).
- **RTC-FR-008**: Perfect Negotiation glare handling per the standard
  pattern: each `PeerController` tracks `making_offer: bool` and exposes
  `polite: bool` (from RTC-FR-001). On receiving an `rtc.offer` while
  `making_offer` is true or the connection's signaling state is not
  `stable`: if **polite**, the controller rolls back its own local offer
  (`setLocalDescription({type: "rollback"})`) and accepts the incoming
  offer; if **impolite**, the controller ignores the incoming offer
  entirely (does not answer it) and lets its own in-flight offer proceed —
  the impolite side's offer will eventually be answered by the polite
  peer once the polite peer's own rollback completes and it processes the
  (re-sent or already in-flight) offer.
- **RTC-FR-009**: Every mutation of a given `RTCPeerConnection` (creating
  offers, setting descriptions, adding/removing tracks, adding ICE
  candidates) is executed exclusively through that peer's
  `PeerController`'s serialized command queue (an `async` task reading from
  an `mpsc`-style channel, or a single-threaded actor loop) — no other part
  of the client (UI event handler, subscription handler, reconnect logic)
  ever touches the `RTCPeerConnection` object directly. This is the
  mechanism that makes RTC-FR-008's ordering guarantees hold in practice:
  commands are processed one at a time, in arrival order, per peer.
- **RTC-FR-010**: `rtc.connection_state` (C→S, telemetry only): `{
  peer_user_id: uuid, state: "new"|"checking"|"connected"|"disconnected"|
  "failed"|"closed" }`, mirroring the SIPSorcery `RTCPeerConnection`'s
  `connectionState` transitions for that peer. Server only logs it
  (`debug`/`info`), never authorizes anything against it, never persists
  it, never relays it to any other client — purely a diagnostic breadcrumb
  for server-side operators.
- **RTC-FR-011**: ICE restart trigger conditions (client-local decision,
  no server involvement beyond routing the resulting renegotiation like
  any other): a `PeerController` initiates an ICE restart when its
  `RTCPeerConnection.connectionState` transitions to `"disconnected"` and
  remains so for **4 seconds** continuously (short blips that self-recover
  within 4s, common on brief Wi-Fi hiccups, are not worth restarting for),
  or immediately upon transitioning to `"failed"`.
- **RTC-FR-012**: ICE restart mechanics: the (would-be) offering side (per
  the same polite/impolite roles — the impolite peer initiates, consistent
  with RTC-FR-003, since ICE restart is "just" another renegotiation)
  calls `createOffer({ iceRestart: true })` and proceeds through the exact
  same `rtc.offer`/`rtc.answer`/`rtc.ice` relay path as any renegotiation —
  no new WS ops are needed for ICE restart, it reuses the existing
  offer/answer/ice catalog. Up to **2 ICE restart attempts** are made
  (tracked per `PeerController`, counter resets to 0 once the connection
  reaches `connected` again); if both fail (connection re-enters `failed`
  after each), the controller gives up on ICE restart and falls back to a
  full `RTCPeerConnection` recreate: close the old object, create a brand
  new one for that same peer (same polite/impolite role, since it's still
  the same UUID pair), and restart from RTC-FR-002 as if the peer had just
  joined (a full fresh offer/answer, not an ICE-restart offer). See
  `flows/reconnect.md` for the exact backoff/timing across all three
  recovery layers.
- **RTC-FR-013**: `PeerController` teardown: on `call.peer_left` for a
  given `user_id` (from `specs/calls.md`), the corresponding
  `PeerController` closes its `RTCPeerConnection`
  (`RTCPeerConnection.Close()`), releases all associated tracks/senders,
  and is removed from the client's peer registry. This is the only path
  that destroys a `PeerController` (no independent "connection failed
  permanently, give up" auto-teardown distinct from an actual
  `call.peer_left` — a peer that's stuck `failed` after exhausting ICE
  restart + recreate attempts (RTC-FR-012) surfaces as a persistent
  per-peer error UI state, per `specs/calls.md`'s per-peer UI states,
  rather than silently removing them from the roster, since the server
  still considers them a call participant until an explicit leave or
  disconnect).
- **RTC-FR-014**: TURN credentials: `GET /rtc/turn-credentials` (Bearer
  auth) returns `{ urls: [string], username: string, credential: string,
  ttl_seconds: int }` where `username` = `"{expiry_unix_ts}:{user_id}"` and
  `credential` = `base64(HMAC-SHA1(shared_secret, username))`, per the
  standard coturn REST API credential format (`turn REST API` /
  `long-term credential mechanism` convention), `ttl_seconds` default 3600.
  `shared_secret` is a server-only config value (env var), never sent to
  clients. Clients fetch fresh TURN credentials once per call join (not
  cached indefinitely — a call that runs longer than `ttl_seconds` refetches
  before expiry; see Recovery behavior) and configure them as an
  additional ICE server alongside a public STUN server
  (`stun:stun.l.google.com:19302` acceptable as a documented default, or a
  self-hosted STUN via the same coturn instance) on every
  `RTCPeerConnection` it creates.
- **RTC-FR-015**: ICE candidate gathering always includes both host/srflx
  (via STUN) and relay (via TURN) candidates — the client never
  pre-emptively decides "we probably don't need TURN"; ICE's own
  connectivity checks determine which candidate pair is actually used
  (direct P2P preferred by ICE priority, TURN relay used automatically
  when direct connectivity fails, per standard ICE behavior — no
  Talkeando-specific logic needed here beyond correct ICE server
  configuration).
- **RTC-FR-016**: `rtc.offer`/`rtc.answer`/`rtc.ice` sent to a `to_user` not
  in the same call as `from_user` (e.g. stale reference after the target
  already left) return `error { code: "not_in_same_call", in_reply_to }`
  to the sender; the client treats this as a signal to tear down that
  specific `PeerController` immediately (equivalent to having received a
  belated `call.peer_left` it missed) rather than retrying.
- **RTC-FR-017**: `RTCPeerConnection` configuration:
  `iceTransportPolicy: "all"` (never `"relay"`-only by default — TURN is
  fallback, not forced; a future diagnostic mode may force relay-only for
  testing but that's not a v1 requirement), `bundlePolicy:
  "max-bundle"`, `rtcpMuxPolicy: "require"` (standard modern defaults,
  minimize port/negotiation surface).
- **RTC-FR-018**: Renegotiation triggered by adding/removing a track
  (`specs/subscriptions.md`) follows the exact same offer/answer/glare
  path as initial connection and ICE restart — there is exactly one
  negotiation mechanism in this system, reused for every trigger (initial
  connect, ICE restart, subscribe, unsubscribe). This uniformity is a
  deliberate design goal: `PeerController` has one `negotiate()` code path,
  not four special cases.
- **RTC-FR-019**: `RTC-014` (verbatim from the product brief, reused
  exactly as specified): **Implementar recebimento e roteamento de ICE
  candidates** — the server-side `rtc.ice` relay handler (RTC-FR-006) is
  this exact task; see `tasks/phase-06-voice.md` where it is reproduced
  with this ID.
- **RTC-FR-020**: A `PeerController`'s command queue processes exactly one
  command at a time to completion (including awaiting async SIPSorcery
  calls like `setLocalDescription`) before dequeuing the next — commands
  queued: `HandleRemoteOffer(sdp)`, `HandleRemoteAnswer(sdp)`,
  `HandleRemoteIce(candidate)`, `AddTrack(kind, mediaStreamTrack)`,
  `RemoveOrDisableTrack(kind)`, `RestartIce()`, `Close()`. UI-facing
  actions (mute, subscribe, unsubscribe) enqueue a command rather than
  calling SIPSorcery APIs directly.
- **RTC-FR-021**: Local ICE candidates gathered by a `PeerController`
  (`onicecandidate`) are sent via `rtc.ice` as soon as gathered (trickle
  ICE, not vanilla/wait-for-complete) to minimize connection setup latency.
- **RTC-FR-022**: A `PeerController` newly created because of RTC-FR-002
  during mesh formation on call join sets up its data purely from the
  known peer's `user_id`; audio track addition happens per
  `specs/audio.md` (local mic track is added to every new
  `RTCPeerConnection` unconditionally — voice is always "published," unlike
  screen/camera which need explicit subscription — see
  `specs/subscriptions.md` for why voice does NOT use the subscribe-gate
  mechanism: everyone in a call always sends and receives audio to/from
  everyone else, by design, since audio is the core call primitive, not an
  optional additional stream).
- **RTC-FR-023**: Connection statistics (`RTCPeerConnection.getStats()`)
  are polled by the (future, phase-09) `QualityController`, not by this
  spec's `PeerController` directly — `PeerController` only exposes the
  underlying `RTCPeerConnection` stats accessor to that consumer; polling
  cadence/adaptation logic is out of this spec's scope.
- **RTC-FR-024**: All `rtc.*` message payload SDP/candidate strings are
  size-sanity-checked server-side (reject >64KB as `error { code:
  "payload_too_large" }`) purely as a DoS guard — normal SDP/candidate
  payloads are a few KB at most.

## Non-functional requirements

- Signaling relay latency (`rtc.offer` received by server → forwarded to
  `to_user`): <50ms p95 (pure in-memory routing, no I/O).
- A freshly joined participant should reach `connected` state with every
  other existing participant within ~3s p95 on a direct-connectable
  network path (no TURN needed), and within ~6s p95 when TURN relay is
  required (extra round trip for relay allocation).
- ICE restart should recover a `disconnected`→`connected` transition within
  ~5s of the restart being triggered, on networks where the new path is
  actually viable.

## UX behavior

Per-peer connection UI states surface through `specs/calls.md`'s roster
tiles: `connecting` (offer/answer/ICE in flight) → `connected` (normal) →
possibly `reconnecting` (ICE restart in progress, shown as a subtle
"reconectando…" badge on that specific tile, audio for that peer may glitch
or briefly mute during this window) → back to `connected`, or → `failed`
(persistent error badge, "Falha na conexão com {name}" with no automatic
further retry beyond the exhausted attempts in RTC-FR-012 — user can
manually leave and rejoin the call to force a fresh attempt for everyone).

## UI states

Per-peer tile: `connecting`, `connected`, `reconnecting`, `failed`. These
are additive to (not replacing) the mute/deafen/speaking states owned by
`specs/calls.md`/`specs/audio.md`.

## API contracts

```
GET /rtc/turn-credentials
Headers: Authorization: Bearer <token>
200 -> { urls: [string], username: string, credential: string, ttl_seconds: int }
```

## WebSocket events

```
rtc.offer (C->S, routed)   { req_id, to_user: uuid, sdp: string }
rtc.offer (S->C, to to_user) { from_user: uuid, sdp: string }

rtc.answer (C->S, routed)  { req_id, to_user: uuid, sdp: string }
rtc.answer (S->C, to to_user) { from_user: uuid, sdp: string }

rtc.ice (C->S, routed)     { req_id, to_user: uuid, candidate: RTCIceCandidateInit }
rtc.ice (S->C, to to_user) { from_user: uuid, candidate: RTCIceCandidateInit }

rtc.connection_state (C->S, telemetry only, no ack) {
  peer_user_id: uuid, state: "new"|"checking"|"connected"|"disconnected"|"failed"|"closed"
}
```
Errors: `error { code: "not_in_same_call" | "payload_too_large",
in_reply_to }`.

## IPC contracts

- UI→Native: `rtc.peer.create { peer_user_id, polite: bool }`,
  `rtc.peer.close { peer_user_id }`, `rtc.peer.handle_offer { peer_user_id,
  sdp }`, `rtc.peer.handle_answer { peer_user_id, sdp }`,
  `rtc.peer.handle_ice { peer_user_id, candidate }` — the UI layer receives
  the raw `rtc.*` WS events (it owns the WS connection per
  `specs/auth.md`'s IPC note) and forwards them to the native layer, which
  owns SIPSorcery and all `PeerController` instances (WebRTC itself is not
  available inside WebView2/JS in this architecture — the native C# layer
  is the actual WebRTC implementation, not the browser's own RTCPeerConnection
  API, which is a deliberate consequence of choosing SIPSorcery over a
  browser-native WebRTC path; document this explicitly since it's a
  non-obvious architectural implication of canon §1's tech stack choice).
- Native→UI: `rtc.peer.connection_state_changed { peer_user_id, state }`
  (drives the per-peer tile UI states above and is also the source event
  the UI forwards to the server as `rtc.connection_state` telemetry),
  `rtc.local_ice_candidate { peer_user_id, candidate }` (UI forwards this
  to the server as `rtc.ice`), `rtc.local_offer_created { peer_user_id,
  sdp }` / `rtc.local_answer_created { peer_user_id, sdp }` (UI forwards
  these to the server as `rtc.offer`/`rtc.answer`).
- Full schemas: `contracts/ipc-native-ui.md`.

## Data model

None persisted — `PeerController`/`RTCPeerConnection` state is entirely
in-memory on the client, per-call-session lifetime only.

## State transitions

Per-`PeerController`: `new` → `connecting` → `connected` ⇄ `reconnecting`
(via ICE restart) → `connected`, or `connecting`/`reconnecting` → `failed`
(terminal for that `PeerController` instance; recovered only by a full
recreate per RTC-FR-012, which is a new instance, not a transition) → any
state → `closed` (on `call.peer_left`). See
`../state-machines/peer-connection.md` (owned by the other writer) for the
formal diagram; this prose is authoritative for its content.

## Concurrency model

Exactly one `PeerController` per remote peer, each with its own serialized
command queue (RTC-FR-009, RTC-FR-020) — this is the core concurrency
invariant of the entire RTC subsystem: no two logical operations on the
same `RTCPeerConnection` ever interleave. Different peers' `PeerController`s
run fully independently/concurrently of each other (no shared lock across
peers) since they represent entirely separate connections.

## Security considerations

- TURN credentials are short-lived (RTC-FR-014) and scoped by a
  server-generated username embedding an expiry timestamp — a leaked
  credential is useless after `ttl_seconds`, unlike a static shared TURN
  password.
- The signaling relay authorization (RTC-FR-004/005/006, "both must be in
  the same active call") prevents a malicious or buggy client from sending
  arbitrary SDP/ICE to a user it has no call relationship with — this is
  the primary abuse vector this spec must close.
- SDP/candidate content itself is not sanitized/parsed by the server
  (RTC-FR-007) — this is a deliberate transparency choice per canon §3,
  not a gap; safety here relies on both endpoints being Talkeando clients
  running SIPSorcery, which validates SDP itself. Document this
  trust-boundary reasoning in `../16-security.md` cross-reference.
- Media itself (RTP/RTCP) is encrypted end-to-end between peers via
  DTLS-SRTP (standard WebRTC transport security, provided by SIPSorcery) —
  the server never sees decrypted or even encrypted media bytes at all
  (it's P2P, canon §3), only the signaling metadata.

## Failure modes

- `to_user` not in the same call (already left, never joined, wrong id):
  `error { not_in_same_call }` — client tears down that `PeerController`.
- ICE fails entirely (both restart attempts and the recreate attempt end
  in `failed`, or TURN itself is unreachable — e.g. coturn down): the peer
  tile shows a persistent `failed` state; the user's own audio and other
  peers' connections are unaffected (failure is isolated per-`PeerController`,
  never cascades to the rest of the mesh).
- Oversized SDP/candidate payload: `error { payload_too_large }`, message
  dropped, not forwarded.
- Server restart mid-call: every `PeerController` on every client
  eventually detects its signaling channel (the WS connection) is gone
  (see `flows/reconnect.md`); existing already-`connected` PeerConnections
  keep working (they don't depend on the server once established — P2P
  media flows independently of the WS signaling channel's liveness) but
  cannot renegotiate (subscribe/unsubscribe, ICE restart) until the WS
  reconnects and a fresh `call.join` re-establishes server-side
  authorization state.

## Recovery behavior

Full three-layer recovery is specified in `flows/reconnect.md`:
1. WebSocket signaling channel reconnect (backend connection).
2. Per-peer ICE restart (network path change, existing call membership
   intact).
3. Full call rejoin (`call.leave` implicit-via-disconnect then a fresh
   `call.join`), used when the WS was down long enough that the server
   already expired the participant (CALL-FR-009) or when ICE
   restart+recreate both exhausted their attempts.
TURN credential refresh: a client fetches new credentials
(RTC-FR-014) proactively at roughly 80% of `ttl_seconds` elapsed if the
call is still active at that point, applying them to any *future*
`PeerController` (new peer joins) and to any in-progress ICE restart —
already-established candidate pairs are unaffected by a credential
refresh (ICE doesn't need to redo completed connectivity checks).

## Telemetry

Server logs (`debug`): each relayed `rtc.offer`/`rtc.answer`/`rtc.ice`
(from/to user ids, byte size, never SDP/candidate content). `info`:
authorization failures (`not_in_same_call`), TURN credential issuance
count. Client-local: `rtc.connection_state` values are logged locally for
diagnostics; also sent to the server as the telemetry op (RTC-FR-010) for
server-side operator visibility, per canon §5.

## Testing

- Unit: polite/impolite role determinism (same pair always yields the
  same roles regardless of who computes it); glare rollback logic
  (simulate simultaneous offers, assert exactly one side rolls back);
  TURN credential HMAC generation/verification against the coturn REST
  API spec.
- Integration (server): `rtc.offer`/`answer`/`ice` relay reaches only the
  correct `to_user`; rejected when `to_user` not in the same call;
  oversized payload rejected.
- Integration (client, via a test harness pairing two `PeerController`
  instances in-process or two headless client processes): full
  offer/answer/ICE handshake reaches `connected`; simulated glare
  (both sides trigger renegotiation near-simultaneously) converges to a
  single stable connection without either side getting stuck; ICE restart
  recovers a connection after simulated network path change; exhausting
  ICE restart attempts triggers full recreate.
- Manual/E2E: real 3-4 machine mesh join; unplug/replug network cable or
  toggle Wi-Fi on one machine mid-call and confirm ICE restart recovers
  audio without a full rejoin; kill coturn and confirm direct-path calls
  are unaffected while relay-dependent paths degrade gracefully to
  `failed` for just that pair.

## Acceptance criteria

- Every pair of participants in a call reaches `connected` without manual
  intervention, using deterministic, collision-free negotiation even when
  multiple renegotiations are triggered concurrently by independent
  events (e.g. two simultaneous subscribes).
- No two operations on the same `RTCPeerConnection` ever race (verified by
  the serialized-queue design and glare tests).
- A network path change (ICE restart scenario) recovers the affected
  peer(s) without dropping the whole call for anyone.
- TURN credentials are never valid beyond their stated `ttl_seconds` and
  are never logged/persisted server-side beyond issuance-count metrics.

## Dependencies

- `specs/calls.md` for participant/call authorization data (`CallRegistry`).
- `specs/subscriptions.md` for the primary renegotiation trigger beyond
  initial connect/ICE restart.
- `specs/audio.md` for the always-on audio track added per RTC-FR-022.
- `infra/coturn` deployment for TURN; `RTC-FR-014`'s shared secret must be
  provisioned identically on the Rust backend and the coturn config.

## Future considerations

- `QualityController`-driven adaptive bitrate/resolution (phase-09).
- Forcing `iceTransportPolicy: "relay"` as a diagnostic/support tool.
- Detecting and surfacing asymmetric NAT/firewall issues more specifically
  than a generic `failed` state.
