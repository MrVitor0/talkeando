# Screen Share — Specification

Status: Draft v1
Owner/Domain: Backend (server/src/streams/* — registry only), Client native (client/native/*/ScreenCapture, WGC integration), Client UI (client/ui/src/features/screen-share)
Related canon sections: §3 (subscribe/unsubscribe gating — THE non-negotiable mechanic), §4 (`PublishedStream` model), §5 (`stream.*` ops), §9 (ID catalog)

## Objetivo

Specify screen sharing end-to-end with the mandatory, explicit
subscribe/unsubscribe gating mechanic: a publisher's outbound video stream
to any given peer exists **if and only if** that peer has an active
subscription to it. Zero subscribers means zero outbound frames, always,
for every publisher, at every moment. This is the single most
architecturally important behavior in the entire product and this document
must leave no ambiguity about how it is achieved.

## Contexto

Screen share is layered onto the existing per-peer `RTCPeerConnection` mesh
(canon §3) — publishing a screen does not create any new PeerConnection.
Instead, a stream is announced to the whole call via the server (control-
plane only), and each individual viewer must explicitly opt in
(`stream.subscribe`) before the publisher's client begins sending that
viewer any video bytes. This avoids two things v1 explicitly wants to
avoid: (a) sending screen video to peers who never asked for it (bandwidth/
privacy), and (b) building an SFU (canon: no SFU in v1 — the publisher
sends one independent unicast stream per subscribed viewer, fanned out
client-side, not via any server relay of media).

## Escopo

- `stream.publish` / `stream.published` / `stream.unpublish` /
  `stream.unpublished`
- `stream.subscribe` / `stream.subscription_requested` /
  `stream.unsubscribe`
- The publisher-side per-viewer RTP sender activation/deactivation
  mechanic (the actual gating implementation — "disable sender" approach,
  see Concurrency model / Implementation notes)
- Windows.Graphics.Capture (WGC) integration: monitor and window picker,
  frame capture pipeline, H.264 (primary) / VP8 (fallback) encode
- Screen-share UI: source picker, active-share indicator, viewer-side
  video tile, "you are sharing to N viewers" indicator for the publisher
- Screen source vanished mid-share (window closed, monitor disconnected)

## Fora de escopo

- SFU / server-relayed media (canon: no SFU in v1).
- Recording a screen share.
- Annotation/drawing-over-share tools.
- Sharing system audio captured from the screen-share source itself as a
  distinct always-on feature — v1 models `has_audio` in
  `PublishedStream.metadata` (canon §4) as a capability flag but the actual
  capture of loopback/system audio alongside WGC video is documented here
  as present-if-feasible via WASAPI loopback capture, not a hard v1
  blocker if the loopback capture path proves unreliable on a given
  machine — the video-only path must work unconditionally regardless.
- GDI `BitBlt` fallback capture path (canon: document the seam, do not
  implement in v1).
- `screen_region` stream kind (canon §4: design for, do not build).

## User stories

- As a call participant, I click "Compartilhar tela," pick a monitor or
  window, and start sharing — but nobody sees anything yet until they
  explicitly click to view it.
- As a call participant, I see a banner/thumbnail announcing "Fulano está
  compartilhando a tela" and click it to start watching, at which point
  (and only then) video starts flowing to me specifically.
- As a publisher, I can see how many people are currently watching my
  share, and stopping my share (or a viewer navigating away) immediately
  and correctly updates that count and the corresponding network traffic.
- As a publisher whose shared window closes or monitor gets unplugged
  mid-share, I get a clear notification and the share cleanly ends for
  everyone rather than freezing on a stale frame or crashing.
- As a viewer, if I stop watching, the publisher's client immediately
  stops sending me video — I am not silently still receiving (and paying
  bandwidth for) a stream I closed.

## Functional requirements

### Publish / unpublish

- **SCREEN-FR-001**: `stream.publish` (C→S): `{ req_id, channel_id, kind:
  "screen", metadata: { label: Option<string>, has_audio: bool } }`.
  Server validates the sender is an active participant of the `ActiveCall`
  for `channel_id` (canon §6); creates a new `PublishedStream { id:
  <new StreamId>, owner: <sender>, kind: "screen", call_id: channel_id,
  metadata, viewers: {} }` (empty viewer set — canon §4) in that call's
  `ActiveCall.streams` map; replies to the publisher with `stream.published`
  including the assigned `stream_id`.
- **SCREEN-FR-002**: Server broadcasts `stream.published { stream_id,
  owner, kind: "screen", metadata }` to every OTHER participant in that
  call (the publisher already got its own copy as the direct reply, per
  SCREEN-FR-001 — no redundant self-broadcast).
- **SCREEN-FR-003**: At the moment `stream.publish` is processed, and at
  every moment thereafter until unpublished, the publisher's client sends
  **zero** video bytes for this stream to **any** peer. Publishing
  registers metadata only — it never, under any circumstance, triggers
  the publisher to start capturing-and-sending frames by itself. Capture
  itself (WGC session start) MAY begin locally at publish time (so the
  publisher can preview their own share and so the first subscriber
  doesn't wait for capture warm-up — see SCREEN-FR-016) but the RTP
  sender for every peer remains inactive/absent until that specific peer
  subscribes.
- **SCREEN-FR-004**: A user may have at most one active `screen`-kind
  `PublishedStream` per call at a time (cannot publish two simultaneous
  screen shares in the same call) — `stream.publish` with `kind: "screen"`
  while the sender already owns an active screen stream in that call
  returns `error { code: "already_publishing", in_reply_to }`. (A user MAY
  simultaneously own one `screen` stream and one `camera` stream — see
  `specs/camera.md` — since they are independent `StreamKind`s.)
- **SCREEN-FR-005**: `stream.unpublish` (C→S): `{ req_id, stream_id }`.
  Server validates the sender owns that `PublishedStream`; removes it from
  `ActiveCall.streams`; broadcasts `stream.unpublished { stream_id }` to
  every OTHER participant (and acks the publisher directly). The
  publisher's client, upon sending/processing this, tears down capture
  entirely and deactivates/removes the sender for every currently-
  subscribed peer (see SCREEN-FR-014) — no viewer continues receiving
  frames after unpublish, regardless of their subscription state at that
  moment (unpublish forcibly ends all subscriptions, it does not wait for
  each viewer to unsubscribe first).
- **SCREEN-FR-006**: Unpublish is also triggered implicitly by: the
  publisher leaving the call (`specs/calls.md` CALL-FR-005/CALL-FR-009),
  the publisher disconnecting, or the call itself being torn down
  (`specs/calls.md` CALL-FR-008). In every implicit case, the server
  removes the `PublishedStream` from the registry and broadcasts
  `stream.unpublished` exactly as in the explicit case — there is no
  "orphaned" `PublishedStream` left behind when its owner is no longer a
  call participant, ever.
- **SCREEN-FR-007**: `stream.publish`/`stream.unpublish` for a nonexistent
  call, or where the sender is not a participant, or (for unpublish) where
  the sender does not own `stream_id`: `error { code: "not_in_call" |
  "not_stream_owner", in_reply_to }`.

### Subscribe / unsubscribe (the core gating mechanic)

- **SCREEN-FR-008**: `stream.subscribe` (C→S): `{ req_id, stream_id }`.
  Server validates: sender is a participant of the same `ActiveCall` that
  owns `stream_id`'s `PublishedStream`, and the stream still exists. On
  success: server adds sender's `user_id` to `PublishedStream.viewers`
  (canon §4's `HashSet<UserId>`), and forwards
  `stream.subscription_requested { stream_id, viewer_user_id }` **to the
  stream owner's connection only** (canon §5) — no broadcast to the rest
  of the call, since only the owner's client needs to act on it. The
  server also acks the subscriber directly (implicit success, or an
  explicit `stream.subscribe` ack reusing the generic req_id-ack pattern —
  no dedicated "you are now subscribed" event distinct from the eventual
  media itself arriving is required, though implementations may choose to
  emit one for UI-state clarity; if so, name it
  `stream.subscription_confirmed { stream_id, in_reply_to }` sent only to
  the subscriber — additive, not required for correctness since the
  arrival of actual video frames is the real confirmation).
- **SCREEN-FR-009**: On receiving `stream.subscription_requested`, the
  **owner's** client (via its `PeerController` for `viewer_user_id`,
  `specs/rtc-signaling.md`) activates the RTP sender carrying that stream's
  video track for that **specific peer connection only**. If a sender for
  this stream/peer pair does not yet exist on that `PeerConnection` (first
  ever subscriber to this stream from this particular peer), the owner's
  `PeerController` adds the track (`addTrack`) and triggers renegotiation
  (`rtc.offer`/`rtc.answer` over the existing `PeerConnection`, per
  `specs/rtc-signaling.md` RTC-FR-018) so the viewer's side learns about
  and can receive the new track. If a sender already exists but is
  currently disabled/inactive for that viewer (e.g. this viewer
  subscribed once before, unsubscribed, and is now resubscribing), the
  owner's client re-enables that existing sender WITHOUT renegotiating
  again (see Concurrency model — this is the whole point of the "disable
  sender" approach over "renegotiate away and back").
- **SCREEN-FR-010**: `stream.unsubscribe` (C→S): `{ req_id, stream_id }`.
  Server validates sender is currently a viewer of that stream; removes
  sender's `user_id` from `PublishedStream.viewers`; forwards
  `stream.subscription_requested`'s counterpart to the owner:
  `stream.unsubscribe` is itself forwarded to the owner (S→C, same op
  name, no distinct "unsubscribe requested" wrapper needed since there is
  no ambiguity to resolve for a stop-sending action) as `{ stream_id,
  viewer_user_id }`, and the server acks the unsubscriber directly.
- **SCREEN-FR-011**: On receiving the forwarded `stream.unsubscribe`, the
  owner's client, via that viewer's `PeerController`, **disables** (does
  not remove/renegotiate away) the RTP sender for that stream's track on
  that specific `PeerConnection` — v1's chosen implementation for the
  "stop sending to that peer" requirement is **disable the RTP sender**
  (e.g. SIPSorcery equivalent of stopping/replacing the outgoing track
  with a null/disabled state, or ceasing to feed the encoder for that
  sender while leaving the m-line/transceiver in place) rather than fully
  renegotiating the track out of the SDP. See Implementation notes below
  for the explicit tradeoff and rationale, per canon's instruction to
  document it.
- **SCREEN-FR-012 (THE INVARIANT)**: At every point in time, for every
  `PublishedStream`, and for every potential viewer (every other
  participant in that call), video frames flow from the publisher to that
  viewer **if and only if** that viewer's `user_id` is currently present
  in `PublishedStream.viewers` on the server AND the owner's client has a
  correspondingly enabled sender for that peer. Zero entries in `viewers`
  ⇒ zero enabled senders ⇒ zero outbound video frames for that stream,
  full stop, with no exception (not even "send at a trickle rate to keep
  the connection warm" — literally zero). This must hold:
  - Immediately after publish, before any subscribe (0 viewers ⇒ 0 sends).
  - After every subscribe (that one viewer, and only that viewer, starts
    receiving).
  - After every unsubscribe (that one viewer, and only that viewer, stops
    receiving; others unaffected).
  - After the last viewer unsubscribes (stream keeps existing as
    "published," per SCREEN-FR-013, but sends to nobody — a publish with
    zero current viewers is a valid, expected, steady state, not an error
    or an implicit unpublish).
  - Immediately after unpublish (all viewers' subscriptions are
    server-side cleared and all sends stop, for everyone, atomically from
    the protocol's perspective).
- **SCREEN-FR-013**: A `PublishedStream` remains published (visible via
  `stream.published`/`call.snapshot`'s `streams` list) independent of its
  current viewer count — going from N viewers to 0 viewers never
  auto-unpublishes; only an explicit `stream.unpublish` (or an implicit
  one per SCREEN-FR-006) ends a publish. This is deliberate: a publisher
  sharing to an empty room (everyone looked away) should not have their
  share silently end.
- **SCREEN-FR-014**: `stream.unpublish` while N viewers are subscribed:
  server clears `PublishedStream.viewers` as part of removing the stream
  (no need for N individual unsubscribe round-trips) and the owner's
  client disables/removes every active sender for this stream across all
  its `PeerConnection`s in one local operation; each affected viewer
  learns via `stream.unpublished` (SCREEN-FR-005) and tears down its
  local view of that stream (stops rendering, removes the tile) — the
  viewer does NOT need to send `stream.unsubscribe` in response, since the
  stream no longer exists to unsubscribe from.
- **SCREEN-FR-015**: A viewer subscribing to a stream owned by a user who
  has since left the call, or to a `stream_id` that no longer exists (race
  between publish/unpublish and subscribe arriving), returns `error {
  code: "stream_not_found", in_reply_to }` — the client treats this as "the
  share ended before you could join it," shown as a brief toast, not a
  hard error dialog.
- **SCREEN-FR-016**: The publisher's own local capture (WGC session) MAY
  start as soon as `stream.publish` succeeds (so the publisher gets an
  immediate local preview and so warm-up latency isn't paid at first-
  subscriber time) — this is a client-implementation optimization, not a
  protocol requirement, and it does NOT contradict SCREEN-FR-003: capturing
  frames locally and sending zero of them to any peer are simultaneously
  true and required. An implementation MAY instead defer WGC capture start
  until the first subscriber to save local CPU/GPU while unwatched;
  either choice is acceptable, but if capture is deferred, the first
  subscriber must tolerate the resulting warm-up latency (document actual
  choice made in `18-client-native-architecture.md`, owned elsewhere; this
  spec only constrains the network-visible behavior, not the local
  capture-timing choice).

### Capture / encode

- **SCREEN-FR-017**: Source picker: enumerates available capture targets
  via `Windows.Graphics.Capture` item enumeration — monitors (each
  physical display) and top-level windows (excluding minimized windows and
  Talkeando's own window itself, to avoid the obvious "share the share"
  recursion/confusion). Picker UI shows thumbnails (WGC supports capturing
  a single frame per candidate for thumbnail preview) grouped "Telas" /
  "Janelas."
- **SCREEN-FR-018**: Selected source is captured via a `GraphicsCaptureItem`
  + `Direct3D11CaptureFramePool`, frames converted/fed into the SIPSorcery
  video source pipeline, encoded with H.264 via the Windows Media
  Foundation hardware encoder path exposed by `SIPSorceryMedia.Windows`
  (canon §1's primary codec choice); if MF hardware H.264 encode is
  unavailable on the machine, fall back to VP8 (documented, acceptable,
  not a v1 blocker per canon) — codec choice is negotiated per-peer as
  part of normal SDP offer/answer (standard WebRTC codec negotiation, no
  Talkeando-specific signaling needed beyond what SDP already conveys).
- **SCREEN-FR-019**: Capture frame rate target: 15-30fps adaptive to
  content/CPU (v1 ships a fixed reasonable default, e.g. 15fps, with
  finer adaptive control deferred to phase-09's `QualityController`) —
  resolution follows the source's native resolution/window size, not
  independently configurable in v1 (no manual resolution picker).
- **SCREEN-FR-020**: Screen source vanished mid-share (monitor
  disconnected, shared window closed by the user or its process exits):
  WGC surfaces a capture-session-ended event; the native layer detects
  this, immediately calls the equivalent of `stream.unpublish` for that
  stream (server-side teardown per SCREEN-FR-005/SCREEN-FR-006 applies
  identically — from the protocol's perspective this is just another
  unpublish trigger), and the UI surfaces a distinct toast: "Compartilhamento
  encerrado: a janela/tela não está mais disponível" (distinguishing this
  from a user-initiated stop, per UX behavior below).
- **SCREEN-FR-021**: A viewer's video tile for a subscribed stream shows a
  loading/connecting state between subscribing and the first decoded
  frame arriving, then the live video; if the underlying `PeerConnection`
  degrades (per `specs/rtc-signaling.md`'s per-peer states), the tile
  reflects that (e.g. frozen-frame + "reconectando" overlay) rather than
  silently going blank.
- **SCREEN-FR-022**: Publisher-side UI shows a live "Compartilhando para N
  pessoas" (or "para ninguém no momento" when N=0) count, derived directly
  from the size of `PublishedStream.viewers` as tracked by the owner's own
  client (which it can compute locally from the subscribe/unsubscribe
  forwards it receives — SCREEN-FR-009/SCREEN-FR-011 — without needing an
  additional server query).

## Non-functional requirements

- Time from `stream.subscribe` to first rendered frame for the subscribing
  viewer: <2s p95 when the publisher's capture is already warm (already
  had ≥1 other subscriber, or chose eager capture-start per SCREEN-FR-016),
  <4s p95 on a cold start requiring fresh WGC session + renegotiation.
- Time from `stream.unsubscribe` (or `stream.unpublish`) to the publisher
  actually ceasing to send frames to that peer: <500ms (bounded by one
  `PeerController` command-queue turnaround, no renegotiation wait needed
  for the disable-sender approach — this bound IS the concrete argument
  for choosing "disable sender" over "renegotiate away," see
  Implementation notes).
- CPU/GPU cost of capture+encode must scale with **subscriber count being
  non-zero**, not with the number of PeerConnections that exist — i.e., a
  publisher with 9 other call participants but 0 subscribers must not pay
  N encode passes; per SCREEN-FR-012 there is nothing to encode-and-send
  to anyone in that state (though local preview capture, if eager-started
  per SCREEN-FR-016, still costs one local capture+encode regardless of
  subscriber count — encoding happens once per stream and the resulting
  encoded frames are fanned out per-subscriber-sender, not re-encoded per
  subscriber, standard unicast-fanout-of-one-encode which is a reasonable
  v1 approach given ≤10 participants; note this means bandwidth, not CPU,
  scales with subscriber count in v1's simplecast approach — document this
  explicitly as the v1 model, with per-viewer simulcast/quality layers as
  a future consideration, not a v1 requirement).

## UX behavior

- "Compartilhar tela" button (in `VoiceStatusPanel`'s quick action grid,
  per canon §10) opens the source picker (modal or popover): "Telas" grid
  of monitor thumbnails, "Janelas" grid of open window thumbnails, Cancel.
- On confirming a source: local preview appears immediately in the
  publisher's own `VoiceStatusPanel`/a dedicated "you are sharing" tile;
  `stream.publish` fires; the "Compartilhando para N pessoas" counter
  starts at 0 and updates live.
- Other call participants see an announcement — a compact card/banner in
  the call area: "{display_name} está compartilhando a tela" with a
  thumbnail-less "Assistir" (Watch) button (no thumbnail preview for
  not-yet-subscribed viewers in v1, since generating one would require
  sending at least one frame to everyone, contradicting SCREEN-FR-012 —
  the announcement is metadata-only, by design).
- Clicking "Assistir" sends `stream.subscribe`; the card transitions to a
  connecting state, then to the live video tile once frames arrive; a
  "Parar de assistir" control replaces "Assistir" once subscribed, sending
  `stream.unsubscribe` when clicked and returning the tile to the
  announcement-card form.
- Publisher-initiated stop: a clearly-labeled "Parar compartilhamento"
  control; clicking it immediately (client-locally) tears down capture and
  all senders and fires `stream.unpublish` — viewers see their tile
  replaced by a brief "compartilhamento encerrado" notice before the tile
  is removed.
- Source-vanished stop (SCREEN-FR-020): same visual teardown for viewers,
  but the publisher additionally sees their own distinct toast
  acknowledging the involuntary stop (see above) rather than the
  publisher's UI implying they clicked stop themselves.
- Multiple simultaneous screen shares in one call (different publishers)
  are fully independent — each gets its own announcement card / viewer
  subscription state; a viewer may subscribe to multiple different
  publishers' shares at once if they choose (no artificial "only watch
  one at a time" restriction in v1).

## UI states

- Publisher: idle (not sharing), source-picking, sharing (0 viewers),
  sharing (N>0 viewers), stopping.
- Viewer: announced-not-subscribed, subscribing, subscribed-connecting,
  subscribed-live, subscribed-reconnecting (underlying peer degraded),
  ended (transient, before removal).

## API contracts

None — screen share is entirely WS-signaled plus local capture; no REST
surface.

## WebSocket events

```
stream.publish (C->S)      { req_id, channel_id, kind: "screen", metadata: { label: string|null, has_audio: bool } }
stream.published (S->C, to publisher AND broadcast to other call participants)
  { stream_id, owner: uuid, kind: "screen", metadata, in_reply_to: req_id|null }

stream.unpublish (C->S)    { req_id, stream_id }
stream.unpublished (S->C, to owner AND broadcast to other call participants)
  { stream_id, in_reply_to: req_id|null }

stream.subscribe (C->S)    { req_id, stream_id }
stream.subscription_requested (S->C, to stream owner ONLY)
  { stream_id, viewer_user_id: uuid }
  (server also acks the subscriber directly with success/error, in_reply_to: req_id)

stream.unsubscribe (C->S)  { req_id, stream_id }
stream.unsubscribe (S->C, forwarded to stream owner ONLY, same op name)
  { stream_id, viewer_user_id: uuid }
  (server also acks the unsubscriber directly, in_reply_to: req_id)
```
Errors: `error { code: "already_publishing" | "not_in_call" |
"not_stream_owner" | "stream_not_found", in_reply_to }`.

## IPC contracts

- UI→Native: `screen.enumerate_sources {}` → returns `{ sources: [{ id,
  type: "monitor"|"window", title, thumbnail_png_base64 }] }`,
  `screen.publish_start { source_id }`, `screen.publish_stop {}`,
  `screen.subscribe { stream_id, owner_peer_user_id }`, `screen.unsubscribe
  { stream_id, owner_peer_user_id }`.
- Native→UI: `screen.capture_ended { reason: "user_stopped" |
  "source_vanished" }`, `screen.viewer_count_changed { stream_id, count }`,
  `screen.frame_state_changed { stream_id, state: "connecting"|"live"|
  "reconnecting" }` (per-subscribed-stream, viewer side).
- Full schemas: `contracts/ipc-native-ui.md`.

## Data model

None persisted — `PublishedStream` is exactly canon §4's in-memory struct,
living inside the owning call's `ActiveCall.streams` (canon §6), never
written to Postgres, rebuilt from nothing on server restart (any in-progress
shares simply end; clients detect the WS drop and must re-publish after
reconnecting if they wish to continue sharing — see `flows/reconnect.md`).

## State transitions

Per `PublishedStream`: `nonexistent` → `published` (0 viewers) ⇄
`published` (N>0 viewers, N tracked exactly, transitions on every
subscribe/unsubscribe) → `nonexistent` (unpublish, explicit or implicit).
See `../state-machines/stream.md` (owned by the other writer) for the
formal diagram — SCREEN-FR-012 above is this spec's authoritative
statement of the invariant that diagram must encode.

## Concurrency model

- Server: `PublishedStream.viewers` mutation (insert on subscribe, remove
  on unsubscribe/unpublish) is a simple `HashSet` operation on the
  `ActiveCall` structure already lock-protected per `specs/calls.md`'s
  Concurrency model — no additional locking scheme needed beyond what
  call state already requires.
- Client (publisher side): the decision to enable/disable a given peer's
  RTP sender for a given stream is executed exclusively through that
  peer's `PeerController` command queue (`specs/rtc-signaling.md`
  RTC-FR-009/020) — `stream.subscription_requested`/forwarded
  `stream.unsubscribe` events enqueue an `AddTrack`/
  `EnableSender`/`DisableSender` command on the relevant `PeerController`,
  never mutate the `RTCPeerConnection` directly from the event handler.
  This guarantees subscribe/unsubscribe races (e.g. rapid
  subscribe-then-unsubscribe from a flaky user click) are serialized
  correctly per-peer, same as any other renegotiation trigger.

## Implementation notes — "disable sender" vs "renegotiate away" (canon-mandated tradeoff to document)

v1 chooses **disable the RTP sender** (stop feeding it encoded frames /
set it to an inactive state) rather than **fully renegotiating the track
out of the SDP** on every unsubscribe, and renegotiating it back in on
every resubscribe. Rationale:
- Renegotiation has real cost: an SDP offer/answer round trip per
  subscribe AND per unsubscribe, run through the Perfect Negotiation glare
  handling (`specs/rtc-signaling.md`), for every single viewer toggle.
  With up to 9 potential viewers per publisher in a full 10-person call,
  frequent watch/unwatch behavior (people glancing at a share, tabbing
  away, coming back) could produce a "renegotiation storm."
- Disabling a sender is a local, near-instant operation with no signaling
  round trip at all beyond the one-time `stream.subscribe`/`unsubscribe`
  message itself (which the protocol requires regardless, for server-side
  authorization/bookkeeping) — it directly satisfies the <500ms
  unsubscribe-to-silence latency target above.
- The tradeoff being accepted: the m-line/transceiver for a given stream
  stays present in the SDP for the lifetime of the underlying
  `PeerConnection` once first negotiated, even during long stretches with
  0 viewers for that peer — a small, bounded amount of SDP/transceiver
  bookkeeping overhead per (publisher, potential viewer, stream) triple,
  which is acceptable at v1's ≤10-participant scale and is far cheaper
  than repeated renegotiation. This is a deliberate v1 choice, not an
  oversight, and is documented here and in `../state-machines/stream.md`
  per canon's explicit instruction.
- First-ever subscribe from a given peer for a given stream STILL requires
  one renegotiation (to add the transceiver/track at all) — only the
  second-and-later subscribe/unsubscribe cycles for that same
  (peer, stream) pair skip renegotiation via the disable/enable toggle.

## Security considerations

- Only the stream owner's client receives `stream.subscription_requested`/
  forwarded `stream.unsubscribe` — no other call participant learns who
  else is watching a given share (viewer lists are not broadcast; only the
  owner and the server know the current viewer set).
- Subscribe/unsubscribe/publish/unpublish are all authorized against actual
  call participation server-side (SCREEN-FR-007/SCREEN-FR-015) — a user
  cannot subscribe to a stream in a call they haven't joined.
- Screen content itself is never inspected/relayed/stored by the server
  (canon §3) — it is P2P DTLS-SRTP encrypted between publisher and each
  subscribed viewer directly, identical trust model to voice
  (`specs/audio.md`).
- The "own window excluded from picker" rule (SCREEN-FR-017) prevents a
  trivial recursive-capture footgun, not a security boundary per se.

## Failure modes

- `already_publishing`: user tries to publish a second screen stream in
  the same call — UI disables/hides the share button while already
  sharing rather than relying purely on the error, but the error exists as
  a server-side backstop regardless of client UI state.
- `stream_not_found` on subscribe: share ended in the race window before
  the subscribe was processed — toast, no persistent error state.
- WGC capture session failure at start (e.g. protected content / DRM'd
  window that WGC refuses to capture, a known WGC limitation): surfaced as
  a picker-level error ("Não é possível capturar esta janela") without
  ever calling `stream.publish` for it — v1 does not attempt to work
  around DRM-protected capture restrictions.
- Codec negotiation failure (neither H.264 MF nor VP8 available/agreeable
  between the two peers — extremely unlikely given both are the same
  client build, but theoretically possible on divergent driver states):
  that specific peer's subscription fails to establish video; treated the
  same as a general per-peer RTC failure state
  (`specs/rtc-signaling.md`'s `failed` per-peer badge), scoped to just
  that stream/peer pair, not the whole call.

## Recovery behavior

- Publisher's WS disconnect/reconnect: per `flows/reconnect.md`, an
  in-progress share does not survive a WS drop from the server's
  perspective if the disconnect is long enough to be treated as a call
  leave (`specs/calls.md` CALL-FR-009) — the server will have already
  removed the `PublishedStream` (SCREEN-FR-006). On reconnect, the client
  must explicitly re-`stream.publish` if the user wants to keep sharing;
  v1 does not auto-resume a share silently (the user should be aware
  their share paused/ended during a disconnect — surfaced via the same
  reconnect banner plus, if they were sharing, an explicit "compartilhamento
  interrompido" note prompting them to restart it if desired).
- Viewer's WS disconnect/reconnect: their subscription is likewise
  server-side dropped (removed from `viewers` when their call
  participation itself is dropped per the same CALL-FR-009 path); on
  reconnect + rejoin, if the stream still exists, the viewer sees the
  announcement card again (not-subscribed state) and must click "Assistir"
  again — subscriptions do not silently auto-resume either, consistent
  with the same "explicit re-opt-in after a real disconnect" philosophy.

## Telemetry

Server logs (`info`): publish/unpublish (owner, call, stream kind),
subscribe/unsubscribe (viewer, stream) — ids only. `debug`: viewer count
changes. Never logs frame/codec/media content (there is none server-side
to log).

## Testing

- Unit: viewer-set add/remove logic; "own window excluded" filter in
  source enumeration.
- Integration (server): publish/subscribe/unsubscribe/unpublish full
  round-trip with 3+ simulated participants; verify
  `stream.subscription_requested` reaches ONLY the owner, never other
  viewers or non-participants; verify unpublish clears all viewers and
  broadcasts correctly; verify all the not_in_call/not_stream_owner/
  already_publishing/stream_not_found error paths.
- Integration (client, RTC harness): **the invariant test** — assert zero
  RTP packets are sent for a published-but-unsubscribed stream over a
  sustained window; assert exactly one peer starts receiving packets
  immediately after that peer's subscribe and no other peer is affected;
  assert that peer stops receiving within the <500ms budget after
  unsubscribe while other subscribed peers are unaffected; assert
  resubscribe after a prior unsubscribe does NOT trigger a second
  renegotiation (verify via counting `rtc.offer` sends for that peer
  pair).
- Manual/E2E: real multi-machine 3-4 person call; one shares a window,
  confirm others see the announcement with no video until clicking
  Assistir; confirm CPU/network usage on the publisher does not spike
  before any subscriber exists; unplug the shared monitor mid-share and
  confirm the source-vanished path fires correctly for both publisher and
  viewers.

## Acceptance criteria

- A published screen stream with zero subscribers produces zero outbound
  video frames to any peer, verified by packet-level test assertion, not
  just by UI appearance.
- Subscribing/unsubscribing is scoped strictly to the individual
  viewer — no other participant's video state is ever affected by another
  viewer's subscribe/unsubscribe action.
- Unpublish reliably and immediately (from the protocol's perspective)
  ends the stream for every current viewer, without requiring per-viewer
  unsubscribe round-trips.
- A vanished capture source (window closed / monitor unplugged) always
  results in a clean unpublish and a distinguishable "involuntary stop"
  notice to the publisher, never a frozen frame or a crash.
- Resubscribing to a stream the same viewer previously unsubscribed from
  does not require a fresh SDP renegotiation (verified in tests per the
  Implementation notes tradeoff).

## Dependencies

- `specs/calls.md` for call/participant authorization.
- `specs/rtc-signaling.md` for the `PeerController`/renegotiation mechanics
  every subscribe/unsubscribe and first-publish rides on.
- `specs/subscriptions.md` for the shared generic mechanic this spec is
  the primary concrete instance of (camera reuses the identical mechanic).
- Windows.Graphics.Capture, SIPSorceryMedia.Windows (H.264 MF encode / VP8
  fallback) per canon §1.

## Future considerations

- `screen_region` stream kind (share a cropped area, not a whole
  monitor/window) — canon: design for, not build.
- GDI BitBlt fallback capture path for older Windows builds.
- Per-viewer adaptive quality/simulcast (today: one encode fans out to all
  current subscribers at the same quality).
- Thumbnail previews on the not-yet-subscribed announcement card (would
  require rethinking the zero-frames-to-non-subscribers invariant, e.g. via
  a periodic low-res "poster frame" mechanism — explicitly NOT done in v1
  since it would compromise SCREEN-FR-012 as currently defined).
- Recording / annotation tools.
