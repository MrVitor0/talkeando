# Audio — Specification

Status: Draft v1
Owner/Domain: Client native (client/native/*/Audio, SIPSorceryMedia.Windows integration)
Related canon sections: §1 (SIPSorcery/WASAPI), §3 (RTC architecture), §9 (ID catalog)
Codec correction (post-verification, see `../27-decisions.md`): the codec is
**G722**, not Opus. `SIPSorcery.Media.AudioEncoder` (the core SIPSorcery
package, no extra native dependency) was reflected against directly and its
`SupportedFormats` only ever contains PCMU, PCMA, G722 and G729 — Opus is
not available without adding `SIPSorceryMedia.FFmpeg` (a native
libopus/libavcodec dependency), which this product avoids per its
simplicity mandate. Every mention of Opus below should be read as G722; the
prose is left otherwise intact where the reasoning still applies (mute
timing, per-peer decode isolation, etc.) and corrected inline where the
specific numbers (sample rate, native-rate rationale) depended on Opus.

## Objetivo

Specify local microphone capture, remote audio playback/mixing, mute/deafen
media-layer behavior, speaking (voice-activity) detection, and device
selection integration for voice calls — the always-on media stream every
call participant sends/receives regardless of any subscription mechanic.

## Contexto

Unlike screen share/camera, audio is not gated by `stream.subscribe` — every
call participant always sends their mic track (unless muted) to, and always
receives every other participant's mic track from, all peers in the mesh
(canon §3: "one PeerConnection per remote peer... all tracks... ride the
same PeerConnection"; `specs/rtc-signaling.md` RTC-FR-022). Audio uses G722
via SIPSorcery's built-in codec support (`SIPSorcery.Media.AudioEncoder`);
capture/render uses WASAPI via `SIPSorceryMedia.Windows`.

## Escopo

- Microphone capture pipeline (WASAPI via SIPSorceryMedia.Windows), G722
  encode, attaching the local audio track to every `PeerConnection`
- Remote audio decode/render/mixing (N remote tracks → output device)
- Mute (stop sending, or send silence) and deafen (stop rendering all
  remote audio, and per CALL-FR-011 implies mute)
- Local audio-level metering for the speaking indicator (both local mic
  level, for local UI feedback, and per-remote-peer level, for the
  "who's talking" ring)
- Input/output device selection integration point (actual enumeration and
  picker UI is `specs/devices.md`; this spec owns applying a selected
  device to the capture/render pipeline)
- Basic audio processing toggles: echo cancellation, noise suppression,
  auto gain control (if exposed by SIPSorceryMedia.Windows / WASAPI shared
  mode; document as best-effort, not a custom DSP implementation)

## Fora de escopo

- Custom DSP/noise-suppression algorithms beyond what WASAPI/SIPSorcery
  provide out of the box — v1 does not implement its own audio processing.
- Push-to-talk (future consideration; v1 ships toggle-mute only).
- Per-peer volume sliders (future consideration — v1 has one output device
  and one system-mixed volume per peer at unity gain).
- Adaptive audio bitrate control (owned by future `QUAL-FR-*`/phase-09).
- Spatial/positional audio.

## User stories

- As a call participant, my microphone audio reaches every other
  participant automatically once I join a call, with no separate "enable
  mic" step beyond the OS permission prompt (first-run only).
- As a call participant, I can mute myself and everyone immediately stops
  hearing me, while I can still hear them.
- As a call participant, I can deafen myself (stop hearing everyone) which
  also mutes me, in one action.
- As a call participant, I see a visual indicator (ring/glow) on whoever is
  currently speaking, including myself.
- As a user, if my microphone is denied at the OS level, I get a clear,
  actionable error rather than silently sending nothing with no
  explanation.

## Functional requirements

- **AUDIO-FR-001**: On joining a call (per `specs/calls.md`), the native
  layer opens the currently-selected input device (per `specs/devices.md`,
  default: OS default communications device if the user has not chosen
  one explicitly) via `SIPSorceryMedia.Windows`'s WASAPI capture, wraps it
  in SIPSorcery's audio source pipeline with the G722 encoder, and adds the
  resulting local audio track to every `PeerConnection` created for that
  call (both ones created immediately at join time and any created later
  for peers who join afterward — RTC-FR-002/RTC-FR-022). One microphone
  capture session is shared across all `PeerConnection`s in the mesh (not
  one per peer); the encoded frame is fanned out to every connected peer's
  `RTCPeerConnection.SendAudio`.
- **AUDIO-FR-002**: G722 encoding parameters: 16kHz sample rate (declared as
  an 8kHz RTP clock rate in SDP — a long-standing G.722 quirk, not a bug),
  mono (single channel — voice calls do not need stereo capture), fixed
  ~64kbps bitrate (G722 is not variable-bitrate like Opus; there is no
  encoder-side rate knob to tune — see AUDIO-NFR-002 for the resulting
  bandwidth-budget consequence). Every peer and the shared microphone
  source call `RestrictFormats` to G722 only, so the whole mesh negotiates
  one consistent codec (a single shared capture cannot serve two different
  negotiated formats at once).
- **AUDIO-FR-003**: Mute (`specs/calls.md` `call.state.update { muted:
  true }`) stops the local audio track from producing/sending RTP to all
  peers — implementation: disable/stop the WASAPI capture read loop feeding
  the encoder (preferred, saves CPU) OR keep capturing but discard/never
  encode (acceptable fallback if pausing capture cleanly proves unreliable
  with a given device) — either way, zero audio bytes are sent to any peer
  while muted; this is a client-enforced guarantee (the server does not
  and cannot inspect RTP content to verify it, per canon §3's control-plane-
  only design — mute correctness is entirely a client responsibility, and
  a modified/malicious client could choose not to honor mute, which is an
  accepted trust boundary for a private 10-person deployment, documented
  in `../16-security.md`).
- **AUDIO-FR-004**: Unmuting resumes capture/encoding/sending without
  requiring any renegotiation (the track/sender already exists on every
  `PeerConnection` from AUDIO-FR-001 — mute/unmute never adds/removes the
  track or touches SDP, it only starts/stops the flow of samples, so no
  `PeerController` negotiation command is involved, unlike
  `specs/subscriptions.md`'s subscribe/unsubscribe which DOES renegotiate).
- **AUDIO-FR-005**: Deafen stops rendering ALL remote peers' audio (mute
  the output entirely, e.g. by not pulling decoded samples into the
  render/mix pipeline, or muting the render device's session volume for
  this app) and, per `specs/calls.md` CALL-FR-011, the client also sets
  local mute to true when deafening (UX coupling, not enforced by the
  audio layer itself — the audio layer just receives two independent
  boolean states and applies the "stop sending" and "stop rendering" 
  effects for whichever are currently set).
- **AUDIO-FR-006**: Un-deafening restores rendering of remote audio and
  restores the user's mute state to whatever it was immediately before
  deafening was toggled on (client-local memory of "prior mute
  preference," not server-tracked).
- **AUDIO-FR-007**: Remote audio mixing: each remote peer's decoded PCM
  stream is rendered through a single shared WASAPI render session (one
  output device, N simultaneous decoded streams summed/mixed by the OS
  audio pipeline or by SIPSorcery's internal mixing, whichever
  SIPSorceryMedia.Windows exposes — v1 does not implement custom mixing
  math, it relies on the library's standard multi-source render path).
- **AUDIO-FR-008**: Local speaking indicator: the native layer computes an
  RMS or peak audio level from the raw local capture buffer (pre-encode,
  post any AGC) at a lightweight polling interval (~100ms) and reports
  "is speaking" (level above a threshold, e.g. -40dBFS, for at least 2
  consecutive samples to avoid flicker on transient noise) to the UI via
  IPC — purely local, never sent over the network (peers derive their own
  view of "is this remote peer speaking" from the audio they're actually
  receiving from that peer, per AUDIO-FR-009, not from a self-reported
  signal — self-reporting a speaking flag over signaling would need a new
  `rtc.*`/`call.*` op and is unnecessary when the receiving side already
  has the ground truth in the form of the actual decoded audio).
- **AUDIO-FR-009**: Remote speaking indicator: for each remote peer's
  `PeerConnection`, the native layer taps the decoded incoming audio level
  (same RMS/threshold logic as AUDIO-FR-008, applied per remote track) and
  reports `audio.peer_speaking_changed { peer_user_id, speaking: bool }`
  to the UI via IPC whenever the threshold-crossing state changes (not
  polled continuously to the UI — only on change, to minimize IPC chatter).
- **AUDIO-FR-010**: If deafened, remote speaking indicators still compute
  and display normally in the UI (you can see who's talking even though
  you can't hear them — this is useful, e.g., for silently monitoring a
  channel) — deafen only affects actual audio rendering, never the
  speaking-detection tap, which reads the decoded stream regardless of
  whether it's subsequently routed to the render device.
- **AUDIO-FR-011**: Microphone permission: on first attempt to open the
  capture device, if Windows denies access (privacy settings block
  microphone access for desktop apps, or no input device exists at all),
  the native layer reports `audio.capture_error { code:
  "permission_denied" | "no_device" }` to the UI instead of silently
  proceeding with a muted/no-op track. The call join itself is NOT blocked
  by this (the user still joins, sees/hears others, per
  `specs/calls.md`) — they simply cannot be heard until resolved, and the
  UI must make this unambiguous (see UX behavior).
- **AUDIO-FR-012**: Device change mid-call (e.g. user unplugs headset):
  handled per `specs/devices.md`'s device-change detection; this spec's
  responsibility is that the capture/render pipeline can be redirected to
  a newly-selected device without tearing down the `PeerConnection`s or
  requiring renegotiation (only the local device binding changes, tracks
  and SDP are unaffected).
- **AUDIO-FR-013**: Audio processing toggles (echo cancellation, noise
  suppression, automatic gain control) are enabled by default wherever
  `SIPSorceryMedia.Windows`/WASAPI shared-mode session exposes them (APO-
  based Windows audio effects, or a WASAPI shared-mode stream which
  inherits system-level enhancements) — v1 does not build a settings UI
  toggle for these individually (record as deferred; the underlying
  capability is "whatever the OS/driver provides," not a Talkeando
  feature).
- **AUDIO-FR-014**: On `call.leave` (or implicit disconnect per CALL-FR-009),
  the native layer stops and disposes the capture device session and all
  render sessions/decoders for that call's peers, releasing OS audio
  resources promptly (no lingering open WASAPI handles after leaving a
  call).
- **AUDIO-FR-015**: Volume/gain in v1 is unity for all remote peers (no
  per-peer volume control) and follows the OS-level output device volume
  for the render session as a whole — Talkeando does not implement its own
  master volume slider distinct from Windows' own volume mixer in v1.
- **AUDIO-FR-016**: Screen-share/camera streams (`specs/subscriptions.md`)
  may optionally carry their own audio track (`PublishedStream.metadata.
  has_audio`, e.g. sharing a video with embedded sound) — this is a
  SEPARATE audio pipeline/track from the call's own mic audio, subject to
  the subscribe-gate (unlike mic audio, which is always sent per
  RTC-FR-022); it renders through the same shared WASAPI output session
  when subscribed, mixed alongside call voice audio, at unity gain,
  no separate volume control in v1.

## Non-functional requirements

- **AUDIO-NFR-001**: End-to-end voice latency (mic capture to remote
  playback) target: <150ms p95 on a direct P2P path with no TURN relay,
  <250ms p95 via TURN relay — dominated by network RTT and G722's
  algorithmic delay (lower than Opus's would have been — G722 is a simple
  sub-band ADPCM codec with no look-ahead), not by any Talkeando-added
  buffering (the app must not add its own jitter buffer beyond what
  SIPSorcery's RTP pipeline already provides).
- **AUDIO-NFR-002**: CPU overhead of G722 encode + N-peer decode
  must remain reasonable for a 10-participant mesh on typical consumer
  hardware — G722 is computationally cheap (no psychoacoustic modeling,
  unlike Opus), so this is a smaller risk than originally assumed; no
  specific numeric budget mandated in v1 (no profiling infrastructure
  exists yet), but this is called out as a QUAL/perf area to watch in
  phase-09.
- **AUDIO-NFR-003**: Mute must take effect (stop sending) within one audio
  frame interval (~20ms) of the toggle — perceived by peers as
  effectively instant, no audible trailing fragment.
- **AUDIO-NFR-004**: Speaking-indicator threshold-crossing latency (actual
  speech onset → UI ring appears) should be under ~300ms combined
  local-detection + IPC + render budget, to feel responsive without being
  so jumpy it flickers on breathing/background noise.
- **AUDIO-NFR-005**: Device switch mid-call (AUDIO-FR-012) must not
  produce more than a brief (<500ms) audio gap for the switching user's
  own capture/render; it must produce NO interruption at all for remote
  peers' perception of this user's stream continuity beyond that same
  local gap (no renegotiation-caused silence for others).
- **AUDIO-NFR-006**: No audio data of any kind is ever transmitted to or
  through the Rust backend — confirmed by canon §3's control-plane-only
  design; this spec's implementation must never route PCM/G722 bytes over
  the WebSocket signaling connection under any circumstance (including
  error/fallback paths).

## UX behavior

- Mic permission denied / no device: `VoiceStatusPanel` shows a persistent
  warning icon + "Microfone indisponível" with a tooltip/expandable detail
  distinguishing "permissão negada" (link to Windows privacy settings) vs
  "nenhum dispositivo encontrado"; the user's own participant tile shows a
  muted-with-warning icon distinct from a normal voluntary mute (different
  icon/color so peers — via their own UI reading `muted: true` either way,
  since the server doesn't distinguish reasons — are not the concern here;
  this is purely the *local* user's own UI distinguishing "I chose to mute"
  from "I can't unmute because there's no mic").
- Speaking indicator: a subtle colored ring (using the green `#5ea88a`
  accent) around a participant's avatar/tile while they're above the
  speaking threshold; disappears promptly when they stop.
- Mute/deafen buttons in `VoiceStatusPanel` and `UserPanel` toggle with
  immediate local visual feedback (icon swap), independent of any network
  round trip (mute is 100% client-local per AUDIO-FR-003 — there's nothing
  to "fail" from the server's perspective the way a chat send can fail;
  the only failure mode is AUDIO-FR-011's device-level error).

## UI states

- Mic: available, permission-denied, no-device, muted (voluntary),
  muted (forced by device error), speaking, silent.
- Output: available, no-device (see `specs/devices.md` for the fuller
  device-state matrix this composes with).

## API contracts

None — audio is entirely a client-native/local-device concern plus the
already-specified `call.state.update` WS op (`specs/calls.md`) for
mute/deafen state sync; no new REST/WS surface owned by this spec.

## WebSocket events

None new — audio reuses `call.state.update` (`specs/calls.md`
CALL-FR-010) for mute/deafen and `rtc.connection_state`
(`specs/rtc-signaling.md`) for connection diagnostics. Speaking state is
explicitly NOT sent over any WS event (AUDIO-FR-008/009 — purely local
derivation on both ends).

## IPC contracts

- Native→UI: `audio.capture_error { code: "permission_denied" |
  "no_device" }`, `audio.local_speaking_changed { speaking: bool }`,
  `audio.peer_speaking_changed { peer_user_id, speaking: bool }`,
  `audio.device_changed { direction: "input"|"output", device_id,
  device_name }` (informational echo after a switch completes, whether
  user-initiated via Settings or forced by a device-change event per
  `specs/devices.md`).
- UI→Native: `audio.set_input_device { device_id }`, `audio.set_output_device
  { device_id }` (see `specs/devices.md` for the enumeration/picker this
  feeds from), `audio.set_muted { muted: bool }`, `audio.set_deafened
  { deafened: bool }` — the native layer, upon applying these, both
  performs the local media-layer effect (AUDIO-FR-003/005) and is
  responsible for triggering the corresponding `call.state.update` WS send
  (this spec treats the native layer as the owner of translating a local
  UI mute toggle into both the media effect and the signaling update, kept
  as a single atomic-feeling operation from the UI's perspective — one IPC
  call in, both effects happen).

## Data model

None persisted — audio state (mute/deafen, device selection) is either
ephemeral call state (mirrors `specs/calls.md`'s `ParticipantState.muted/
deafened`, itself in-memory only) or persisted user preference for
*default* device selection, which lives in `specs/settings.md`'s local
settings store, not a server-side table.

## State transitions

Per local audio pipeline: `uninitialized` → `capturing` (call joined,
device opened successfully) ⇄ `muted` (voluntary or forced) → `stopped`
(call left, device closed). Per remote peer's render: `no_stream` →
`rendering` (track received and unmuted upstream) ⇄ `silent-but-connected`
(peer muted or self deafened) → `stopped` (peer left).

## Concurrency model

Capture/encode runs on its own dedicated thread/task (WASAPI capture
callback thread, standard for low-latency audio — must not block on
anything that could stall the audio callback, e.g. no synchronous IPC
calls from within the capture callback itself; level metering (AUDIO-FR-008)
reads from a lock-free ring buffer or similarly cheap mechanism, not a
blocking queue). Each remote peer's decode/render similarly isolated per
peer; mixing happens at the OS/WASAPI render session layer, not via
manual sample-level synchronization code in Talkeando.

## Security considerations

- Mute is a client-enforced, not server-verified, guarantee (documented
  explicitly in AUDIO-FR-003) — acceptable for a trusted small community,
  but recorded as a real trust assumption in `../16-security.md`, not a
  silent gap.
- Microphone access follows standard Windows per-app privacy permission
  model; Talkeando requests no elevated/unusual audio capabilities.
- No audio content is ever logged, persisted, or sent to the Rust backend
  under any code path (AUDIO-NFR-006).

## Failure modes

- Permission denied / no device at call join time: user joins successfully
  but cannot be heard; UI clearly communicates this (AUDIO-FR-011, UX
  behavior above) — never a silent failure.
- Device removed mid-call (headset unplugged) without a configured
  fallback device: capture/render pipeline reports the same
  `audio.capture_error`/an equivalent output error; existing
  `PeerConnection`s remain intact (no renegotiation forced by a device
  error alone) so the user can plug back in or pick another device via
  Settings and resume without rejoining the call.
- WASAPI/SIPSorceryMedia.Windows internal failure (driver crash, exclusive-
  mode conflict with another app): surfaces as the same capture/render
  error family; a full pipeline restart (close and reopen the device
  session) is attempted once automatically before surfacing a persistent
  error to the user.

## Recovery behavior

Device-level errors recover via user action (replug device, choose a
different one in Settings) or the one automatic pipeline-restart retry
noted above; they never require rejoining the call or affect
`PeerConnection`/signaling state (audio device health and RTC connection
health are independent failure domains by design).

## Telemetry

Local diagnostic logging only (device open/close, capture errors, one
retry attempt outcome) — no content, no remote telemetry backend in v1.

## Testing

- Unit: speaking-threshold hysteresis logic (does not flicker on
  borderline levels); mute/deafen coupling and prior-mute-restore logic.
- Integration: joining a call with a mocked/virtual audio device produces
  a track added to every `PeerConnection`; mute stops outbound RTP
  (assert via a test harness inspecting sent packet counts) without any
  renegotiation event firing; device switch mid-call does not trigger
  `PeerConnection` renegotiation.
- Manual: real headset mute/unmute audible-latency check; unplug/replug
  during a live call; permission-denied path (revoke mic permission in
  Windows Settings, attempt to join, confirm clear UI messaging and that
  the join still succeeds).

## Acceptance criteria

- Joining a call with a working mic results in other participants
  receiving audio with no explicit "enable" step.
- Muting stops all outbound audio to every peer within one audio frame,
  verified by packet inspection in tests.
- No audio bytes are ever observed on the server/backend side under any
  test scenario.
- A denied/missing microphone never blocks joining or listening, and is
  always clearly surfaced to the user, never silent.
- Deafen reliably stops all remote audio rendering while still allowing
  visual speaking indicators to function.

## Dependencies

- `specs/calls.md` for `ParticipantState.muted/deafened` and
  `call.state.update`.
- `specs/rtc-signaling.md` for the `PeerConnection`/`PeerController` each
  audio track attaches to.
- `specs/devices.md` for device enumeration/selection/change detection.
- SIPSorcery + SIPSorceryMedia.Windows (canon §1) as the concrete
  implementation library.

## Future considerations

- Push-to-talk.
- Per-peer volume control.
- User-facing toggles for echo cancellation/noise suppression/AGC.
- Adaptive audio bitrate under `QUAL-FR-*` (phase-09) — moot for v1's fixed-
  rate G722, revisit if a future codec change reintroduces Opus via
  `SIPSorceryMedia.FFmpeg`.
- Custom noise suppression (e.g. RNNoise) if OS-level suppression proves
  insufficient.
