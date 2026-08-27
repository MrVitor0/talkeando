# 27 — Decisions Log (ADR)

Status: Living document — append new decisions here as they are made or
corrected during implementation. Do not delete superseded entries; mark them
superseded and link forward.

Format: one entry per decision, numbered, with the decision, the reasoning,
and (where applicable) how it was verified.

---

## ADR-001 — Audio codec is G722, not Opus (supersedes the original v1 canon)

**Status:** Decided, implemented (`client/native/Talkeando.Client/RtcEngine.cs`).

**Context:** The original architecture brief and every early SDD document
(`00-product-overview.md`, `02-requirements.md` AUDIO-FR-004,
`05-client-architecture.md`, `10-webrtc-architecture.md`,
`13-audio-pipeline.md`, `specs/audio.md`) assumed Opus as the voice codec,
on the stated basis that "SIPSorcery's Opus codec support" would provide it.

**What was verified:** reflecting directly on `SIPSorcery.Media.AudioEncoder`
(package `SIPSorcery` 6.2.4, the version compatible with the .NET 6 SDK
actually installed on the target dev machine) shows its constructor takes a
single `includeLinearFormats` bool, and `SupportedFormats` only ever
contains: PCMU, PCMA, G722, G729. There is no Opus codec anywhere in the
core `SIPSorcery` package. Opus support would require the separate
`SIPSorceryMedia.FFmpeg` package, which wraps native libopus/libavcodec
binaries that must be bundled and shipped alongside the app.

**Decision:** Ship v1 with **G722** (16kHz wideband speech codec, RTP clock
rate declared as 8000 per a long-standing G.722 spec quirk — the real
sample rate is 16kHz). It is the only wideband option SIPSorcery's core
package supports without adding a native dependency, matching this
product's explicit "no overengineering / minimal operational surface"
mandate more closely than bundling FFmpeg would.

**Consequences:**
- No adaptive Opus bitrate control in v1 (G722 is effectively fixed-rate,
  ~64kbps) — `QUAL-FR-*` (phase-09) audio scope shrinks accordingly; it now
  focuses on video quality adaptation, not audio bitrate.
- Every `RTCPeerConnection`'s audio track and the shared microphone capture
  endpoint call `RestrictFormats(f => f.Codec == AudioCodecsEnum.G722)` so
  the whole mesh negotiates one consistent codec — this is required because
  a single shared microphone capture instance encodes once for every peer
  connection and cannot serve two different negotiated codecs at once.
- Revisit if voice quality on constrained links proves inadequate: adding
  `SIPSorceryMedia.FFmpeg` for real Opus support is a contained, scoped
  future task (bundle native FFmpeg binaries with the installer, swap the
  `IAudioEncoder` implementation) — not a rearchitecture.

**Affected documents corrected in the same pass:** `00-product-overview.md`,
`02-requirements.md`, `04-system-architecture.md`, `05-client-architecture.md`,
`10-webrtc-architecture.md`, `13-audio-pipeline.md`, `specs/audio.md`,
`30-v1-delivery-plan.md`.

---

## ADR-002 — SIPSorcery/SIPSorceryMedia.Windows pinned to the 6.x line

**Status:** Decided, implemented (`client/native/Talkeando.Client/Talkeando.Client.csproj`).

**Context:** The dev machine has only the .NET 6 SDK installed
(`dotnet --list-sdks` → `6.0.400`). `SIPSorceryMedia.Windows` 10.0.16 (the
version initially pinned) targets `net10.0-windows10.0.17763` and fails
`dotnet restore` against `net6.0-windows10.0.19041.0` with NU1202.

**Decision:** Pin `SIPSorcery` to `6.2.4` and `SIPSorceryMedia.Windows` to
`6.0.5` — the newest versions in the 6.x line, which restore and build
cleanly against the installed net6.0-windows SDK (verified: `dotnet build`
succeeds with 0 errors/0 warnings).

**Consequences:** the client is pinned two major versions behind
SIPSorcery's latest; upgrading later requires either installing a newer
.NET SDK on build machines or re-verifying API compatibility at the pinned
major version boundary before bumping. Do not bump these versions without
re-running the reflection-based API verification this ADR is based on
(constructor signatures and enum/method availability have changed across
SIPSorcery major versions during this investigation).

---

## ADR-003 — Screen share: VP8 via `SIPSorceryMedia.Encoders`, capture via
GDI (`System.Drawing`/`System.Windows.Forms.Screen`), not
`Windows.Graphics.Capture`; a dedicated WPF window renders a watched
stream, not an embedded WebView2 tile

**Status:** Decided, implemented (`RtcEngine.PublishScreen`/
`UnpublishScreen`/`SetScreenSubscription`, `ScreenShareViewerWindow`).

**Video codec — what was verified:** `SIPSorceryMedia.Encoders` has no
release in the same 6.x line as the pinned `SIPSorcery`/
`SIPSorceryMedia.Windows` packages (its version list jumps `0.0.13` →
`8.0.7`). Reflection confirmed `0.0.13` still restores and builds cleanly
against our net6.0-windows + SIPSorcery 6.2.4 pin, and its
`SIPSorceryMedia.Encoders.VpxVideoEncoder` class implements
`SIPSorceryMedia.Abstractions.IVideoEncoder` with a working
`EncodeVideo`/`DecodeVideo` pair and reports one supported format: VP8,
dynamic payload type 96, 90kHz clock. This is a real, working VP8 encoder —
**not** the originally-planned H.264 (which would need
`SIPSorceryMedia.FFmpeg`, a much larger native dependency, for a marginal
quality gain not worth it at this product's scale). VP8-only for v1.

**Capture — what changed from the original plan:** the canon/early SDD
docs specified `Windows.Graphics.Capture` (WGC) as primary, with GDI BitBlt
as a documented-but-deferred fallback. In practice, WGC requires WinRT COM
interop (`IGraphicsCaptureItemInterop`, `IDirect3DDxgiInterfaceAccess`) that
this session had no way to exercise at runtime (no capturable display in
the build environment, and COM interop bugs do not show up as compile
errors). Per the project's own rule ("não finja que está pronta" — section
38 of the founding brief), shipping unverified COM interop as if it were
tested would be dishonest. **Decision: swap the priority** — GDI
`Graphics.CopyFromScreen` (via `System.Drawing`, enabled through
`<UseWindowsForms>true</UseWindowsForms>` alongside the existing
`<UseWPF>true</UseWPF>`) is the v1 capture method; `Windows.Graphics.Capture`
becomes the deferred upgrade (`SCREEN-FR` follow-up), for when per-window
capture and occlusion-aware compositing are actually needed.

**Consequences / scope cut:** v1 screen share captures a **whole monitor**,
selected from `System.Windows.Forms.Screen.AllScreens` — there is no
per-window picker in v1 (the original "seleção de janela" requirement is
deferred). Capture runs at a fixed, configurable frame rate (default 15fps)
via a plain polling loop (`Task.Delay` between `CopyFromScreen` calls), not
an event-driven frame-arrival callback — acceptable at this product's
±10-person scale, revisit if CPU cost proves too high (`OBS-NFR`/`QUAL-FR`
watch item).

**Subscription gating — how the zero-viewer invariant is actually
implemented:** exactly one video `MediaStreamTrack` (VP8, SendRecv) is added
to every `RTCPeerConnection` once, at creation time, and never
renegotiated afterward. Capture and VP8 encoding start the moment
`stream.publish` fires (the user chose to share), independent of whether
anyone is watching — but the encoded-sample callback only calls
`RTCPeerConnection.SendVideo` for peers present in that stream's
`Subscribers` set, which is populated only by `stream.subscription_requested`
/ `stream.unsubscribed` arriving over the WebSocket (server-authorized, see
`ws/handler.rs`). Zero subscribers therefore still means zero video RTP
leaves the process for that peer, satisfying `SUB-FR-001`, even though the
encoder itself is warm. This mirrors the mute implementation (gate the
send, never touch the track/m-line) specifically to avoid a renegotiation
storm on every subscribe/unsubscribe.

**Rendering — why a separate window instead of an embedded tile:**
decoded frames (BGRA, via `VpxVideoEncoder.DecodeVideo` fed from
`RTCPeerConnection.OnVideoFrameReceived`) are pushed into a
`System.Windows.Media.Imaging.WriteableBitmap` (`Bgra32` — a byte-for-byte
match, no pixel format conversion needed) inside a dedicated
`ScreenShareViewerWindow`. Compositing video into the WebView2-hosted DOM
instead would need either a native-to-DOM frame bridge (expensive to pipe
raw frames through IPC/JSON at video framerate) or a transparent overlay
positioned in lockstep with a DOM element's on-screen rect — both add
real complexity this session could not validate end-to-end. A plain WPF
window is simple, real, and satisfies "Bob can watch Alice's screen" today;
moving it into an embedded tile in the main window is a scoped follow-up
UI task (`UX-FR`/`SCREEN-FR` — see `31-implementation-status.md`).

**v1 simplification accepted:** a remote peer's decoded video frames are
routed to a viewer window keyed by *peer user id*, not by *stream id* — the
delivery plan already limits v1 to one screen stream per publisher at a
time (`30-v1-delivery-plan.md` M1.3), so this is lossless in practice but
would need revisiting if that scope-cut is ever lifted (e.g. simultaneous
screen + camera from the same user).

**Native dependency bundling verified (2026-08-27):** `VpxVideoEncoder`
wraps a native library (`vpxmd.dll`, ~x64/x86 builds of libvpx), which is a
real deployment risk for a packaged installer — a missing native DLL would
fail silently or crash only at first use, not at build time. Confirmed by
running the actual release pipeline (`dotnet publish -c Release -r win-x64
--self-contained false`, the same command `client/native/installer/
README.md` specifies): `vpxmd.dll` is copied into the publish output root
correctly (via the package's `build/x64/vpxmd.dll` MSBuild content
convention, not the `runtimes/` RID-graph convention — worth knowing if
this ever needs a self-contained or single-file publish, whose asset
trimming rules differ between the two conventions). No installer-time gap.

---

## ADR-004 — Chat retry reuses the same `req_id`; `messages.client_req_id`
is a real idempotency key, not just a correlation id

**Status:** Decided, implemented (`server/migrations/0002_message_idempotency.sql`,
`ws/handler.rs::handle_chat_create`, `client/ui/src/App.tsx`
`retryMessage`/`sendOptimistic`). Runtime-verified against a live Postgres
instance in this session (not just compiled) — see below.

**What the earlier draft spec said (`specs/chat.md`, written before this
was implemented):** CHAT-FR-012 originally said a retry should generate a
**fresh** `req_id`, discarding the old one. That is actually unsafe: `req_id`
is also this system's only idempotency key for `chat.message.create`. If a
retry uses a new key, a case where the *original* send actually succeeded
server-side but its confirmation was lost/delayed on the way back to the
client (WS hiccup, client reconnect mid-flight) results in the retry
inserting a **second**, duplicate message — exactly the failure mode
optimistic-retry UIs are supposed to avoid.

**Decision:** retry reuses the exact same `req_id`. Server-side,
`INSERT INTO messages (..., client_req_id) VALUES (...) ON CONFLICT
(channel_id, author_id, client_req_id) WHERE client_req_id IS NOT NULL DO
UPDATE SET content = messages.content RETURNING id, ..., (xmax = 0) AS
is_new_insert` either inserts a fresh row or resolves to the existing one
for the same key — the `DO UPDATE` clause is a no-op reassignment, present
only so `RETURNING` still yields the existing row on conflict (`INSERT ...
ON CONFLICT DO NOTHING` cannot do this). `xmax = 0` is the standard
Postgres tell for "this row came from the INSERT, not the conflict path" —
used to skip re-running attachment association on a resolved retry, and
critically, **to send the confirmation only back to the retrying client**
(`hub.send_to`) instead of rebroadcasting to the whole community
(`broadcast_to_community`): everyone else already received the original
broadcast (or the send never reached the server at all, in which case
there is nothing to duplicate for them either way).

**Runtime verification performed:** a live Postgres 16 container plus a
running `talkeando-server` instance were used to send two
`chat.message.create` messages over a real WebSocket with the identical
`req_id`. Result: both responses referenced the same message `id` and
`created_at`, and a direct `SELECT` against the `messages` table confirmed
exactly one row exists. This is the first runtime (not just compile-time)
verification performed on this codebase.

**Consequence:** `specs/chat.md` CHAT-FR-012 and the client optimistic-send
lifecycle description were corrected in the same pass as this ADR — they
previously described the fresh-req_id design that this ADR supersedes.

---

## ADR-005 — Screen share sent zero frames because of two stacked bugs in
the video source, both hidden by one silent catch block

**Status:** Fixed and empirically verified (2026-08-27), found during a
real two-user manual test (two isolated client profiles, see ADR-006),
not a synthetic scenario.

**Symptom:** every signaling step for screen share worked — publish,
`stream.published` broadcast, `stream.subscribe`, `stream.subscription_requested`
routed to the owner — confirmed line-by-line in per-profile debug logs.
Yet the viewer window never received a single frame, forever showing
"Aguardando o primeiro quadro".

**Root cause #1 — wrong class entirely:** `PublishScreen` used
`SIPSorceryMedia.Windows.WindowsVideoEndPoint` (constructed with an empty
device id, intending to bypass its camera-capture role and just use it as
an encode pipe fed via `ExternalVideoSourceRawSample`). Verified by direct
execution that this does not work: `WindowsVideoEndPoint.
ExternalVideoSourceRawSample` unconditionally throws
`ApplicationException("The Windows Video End Point does not support
external samples. Use the video end point from SIPSorceryMedia.Encoders.")`
— it is camera-device-capture-only, full stop, regardless of device id.
The real class for feeding externally-sourced raw frames (GDI screen
capture, in our case) into the same encoder ecosystem is
`SIPSorceryMedia.Encoders.VideoEncoderEndPoint`.

**Root cause #2 — wrong unit, only discoverable after fixing #1:** even
after switching classes, feeding frames still failed, this time with
`DivideByZeroException` inside the encoder. The first argument of
`ExternalVideoSourceRawSample` was being passed as an RTP-clock duration
(`describes 6000 = 90000Hz / 15fps`, mirroring how `SendAudio`/`SendVideo`
take RTP units) — but reflecting the exception's own stack trace showed
the real parameter name: `durationMilliseconds`. It expects **milliseconds
per frame** (e.g. `66` for 15fps), not an RTP-unit value, and converts to
RTP units internally before invoking `OnVideoSourceEncodedSample` (verified
by feeding realistic ms values and confirming the callback fires with
correctly-scaled RTP durations).

**Why this took so long to find:** `CaptureScreenLoopAsync`'s per-frame
try/catch around `ExternalVideoSourceRawSample` was a bare `catch { break;
}`, added defensively for a completely different scenario (a monitor
physically disconnecting mid-share). It caught *both* of the above
exceptions identically and silently, on literally the first frame, every
single time, across every test — including the very first solo test, long
before a second user was ever involved. Nothing about "watching yourself
has no peer connection" (the earlier, correct diagnosis for the *first*
failed test) explained *this* — that theory was actually a red herring for
a bug that had been there from the start. The catch block now logs via
`DebugLog` instead of swallowing silently.

**Fix:**
1. `PublishScreen` now constructs `VideoEncoderEndPoint` (no constructor
   args needed — it self-registers VP8 support), calls
   `RestrictFormats`, `SetVideoSourceFormat(vp8Format)`, and `await
   StartVideo()` before the capture loop starts (mirroring the audio path's
   `StartAudio()`, which screen share had never had an equivalent for).
2. `CaptureScreenLoopAsync` now passes `1000 / fps` (milliseconds) instead
   of `90000 / fps` (RTP units) to `ExternalVideoSourceRawSample`.
3. The capture loop's catch block logs the exception instead of swallowing
   it — the single change most likely to prevent a bug like this from
   hiding for this long again.

**A third bug in the same feature, found immediately after the above two
were fixed and a real frame finally arrived — the viewer rendered solid
black instead of the shared screen.** Round-trip tested directly
(encode a known solid-color image, decode it, inspect the bytes):
`VpxVideoEncoder.DecodeVideo` **ignores its `VideoPixelFormatsEnum`
parameter entirely** — requesting `Bgra`, `Bgr`, `Rgb`, and `I420` all
produced the exact same output, `width * height * 3` bytes (confirmed
3 bytes/pixel, not 4). `RtcEngine`'s decode call and
`ScreenShareViewerWindow`'s `WriteableBitmap` had both assumed 4-byte BGRA
(`PixelFormats.Bgra32`, stride `width * 4`) — feeding a 25%-smaller buffer
than that stride implies corrupts/fails `WritePixels`'s internal
buffer-size check, and since the `WriteableBitmap` had already been
constructed and assigned as the image source *before* the failed write
(needed to hide the "waiting for first frame" placeholder), the failure
was invisible: the view just kept showing that freshly-constructed
bitmap's default content, which is black. Fixed by switching to
`PixelFormats.Bgr24` (a real, exact match for 3-byte-per-pixel BGR) and
stride `width * 3` — see `ScreenShareViewerWindow.xaml.cs`. The decode call
now requests `Bgr` instead of `Bgra` for honesty, though it has no actual
effect on the library's behavior.

**Lesson applied elsewhere in this session, restated here because this is
the clearest example of it:** an empty or overly-broad `catch` block is not
"defensive code", it is a blindfold. Every catch block introduced in this
codebase from this point on must either log what it caught or have a
one-line comment explaining precisely why swallowing it silently is
correct — "might be a disconnected monitor" was not a sufficient reason,
because it was never actually verified to be the only case reaching that
catch, and it wasn't.

---

## ADR-006 — Local multi-instance testing needs its own profile, or two
windows corrupt each other's session

**Status:** Fixed (2026-08-27), found during the same manual two-user test
session that led to ADR-005.

**Symptom:** running two `dotnet run` instances on one machine to simulate
two users (as `README.md` originally suggested, with no caveat) let the
second login silently overwrite the first window's saved session, since
`SessionStore` always wrote to one hardcoded path
(`%LOCALAPPDATA%\Talkeando\session.bin`) — and `NetworkClient` reloads the
token from disk on every REST call rather than caching it, so a request
from window A made *after* window B logged in could silently carry window
B's bearer token.

**Fix:** added `TALKEANDO_PROFILE` (an env var, checked once via a small
`Profile` static helper) that suffixes the session file, the WebView2
user-data folder, the debug log file, and the window title. Set it before
`dotnet run` (e.g. `TALKEANDO_PROFILE=alice`) to get a fully isolated local
instance. Unset, behavior is identical to before (one shared default
profile) — this is purely a local-testing convenience; a real deployment
has one user per machine and never sets this.

**Consequence:** `README.md`'s two-accounts-on-one-machine instructions
were corrected to use this instead of two bare `dotnet run` calls.

---

## ADR-007 — Screen share quality presets, and a UI-thread freeze bug this introduced

**Status:** Fixed (2026-08-27).

**Context:** after ADR-005 got frames flowing, real testing showed low
apparent quality and ~10fps regardless of the source monitor's native
resolution — because the capture loop grabbed the full native-resolution
monitor on every frame and encoded that, with no user control over
resolution or target fps at all.

**Decision:** added `ScreenShareQuality` (`RtcEngine.cs`) — presets
`720p30`/`720p60`/`1080p30`/`1080p60`, default `720p60` per product
request — and rewrote `CaptureScreenLoopAsync` to scale each captured
frame down to the preset's target height (preserving aspect ratio, both
dimensions rounded to even for VP8 chroma subsampling) before handing it
to the encoder. Fewer pixels is real per-frame GDI-blit and VP8-encode CPU
savings, not just a bandwidth choice. `client/ui`'s monitor-picker got a
quality `<select>` wired into the `stream.publish` payload.

**Bug introduced and fixed in the same pass:** the capture loop was
started as a bare fire-and-forget call (`_ = CaptureScreenLoopAsync(...)`)
from `PublishScreen`, itself invoked directly off the WebView2 message
handler — i.e. the UI/Dispatcher thread. An un-awaited async method runs
*synchronously on its caller's thread* up to its first real `await`; the
loop's only `await` is `Task.Delay(remaining, ...)`, gated on
`remaining > 0`. At 60fps the per-frame budget is ~16ms — if a GDI capture
+ scale + VP8 encode ever took longer than that (plausible at 720p/1080p
with no hardware-accelerated capture path, see ADR-003), `remaining` was
never positive and the loop spun forever with no yield point, freezing
the whole window ("Não está respondendo"), reproduced by the user on
every share attempt after this feature landed. Fixed by starting the loop
via `Task.Run(...)` instead, so even the pre-first-`await` portion always
executes on a thread-pool thread, never the UI thread, regardless of how
slow any single frame is.

**Consequence:** any future fire-and-forget async call originating from
an event handler on `IpcBridge`/`MainWindow` needs the same `Task.Run`
treatment unless it is known to await immediately — the WebView2 message
handler runs on the UI thread and there is no compiler warning for this
class of bug.

---

## ADR-008 — `VpxVideoEncoder.TargetKbps` is a no-op in the pinned
`SIPSorceryMedia.Encoders` 0.0.13 package: there is no real quality/bitrate
control available, and higher resolution presets look *worse* per-pixel

**Status:** Confirmed by direct testing (2026-08-27), not fixed — no fix is
available within the pinned dependency.

**Symptom:** even after ADR-007's resolution/fps presets, screen share
still looked blocky at every preset including 1080p60, and the image
looked corrupted for roughly the first second of a new share before
"settling."

**What was verified:** wrote a throwaway console harness
(scratchpad, not committed) that calls `VpxVideoEncoder.EncodeVideo`
directly on synthetic noisy 640x480 BGRA frames, across a 40-frame series,
with `TargetKbps` unset, and set to 300, 2000, 6000, and 12000. Output was
**byte-for-byte identical in every run** — same ~100KB keyframe, same
~11.7KB steady-state per-frame size, regardless of the requested target.
The property is a plain settable field on the public API (and even
threads down to `Vp8Codec.InitialiseEncoder(width, height, targetKbps)`
internally) but has no observable effect on the actual libvpx encode call
in this package version — a bug in the dependency, not in this codebase's
capture/quality code.

**Consequence — this explains both symptoms:**
- The encoder always spends the same small, fixed number of bits per
  frame no matter the resolution. At 1080p that fixed budget is spread
  over ~2.25x the pixels of 720p, so **higher-resolution presets produce
  visibly *more* compression artifacts per pixel, not fewer** — there is
  no way to raise quality by raising resolution with this dependency.
- The very large first keyframe (~100KB in the 640x480 test; larger at
  720p/1080p) is more RTP packets to reassemble before it can decode
  correctly, and this stack has no NACK/retransmission wired up for video
  RTP (see `RtcEngine.cs`) — a keyframe with any packet loss renders
  corrupted until the next (much smaller) delta frame arrives, which
  matches the "garbled at the start, then clears up" pattern.

**Decision:** documented as a known v1 limitation rather than worked
around. A real fix means bypassing this managed wrapper (P/Invoke
straight to libvpx with correct rate-control parameters) or replacing the
video codec dependency entirely — both are materially larger undertakings
than this session's scope, not a quality-preset tweak. `ScreenShareQuality`
(ADR-007) still stands: it controls real, working levers (resolution,
fps → CPU cost), it just does not and cannot control compression quality
given this dependency.

**Superseded by ADR-009** — rather than bypass the wrapper, the whole
media pipeline moved to a real WebRTC engine that does not have this bug.

---

## ADR-009 — WebRTC (voice mesh + screen share) moved from C#/SIPSorcery
into the WebView2 browser engine itself (`client/ui/src/rtc.ts`)

**Status:** Implemented (2026-08-27), superseding ADR-002/003/005/007/008's
native C# media pipeline. ADR-001 (G722) and ADR-004 (chat idempotency)
are untouched — this only concerns voice/screen-share media, not audio
codec choice or chat.

**Context:** ADR-008 found that `VpxVideoEncoder.TargetKbps` — the only
bitrate/quality control the pinned `SIPSorceryMedia.Encoders` 0.0.13
package exposes — is a complete no-op, confirmed by direct testing
(identical encoder output across `TargetKbps` values from unset to
12000). Combined with ADR-005's three stacked bugs (wrong endpoint class,
wrong duration unit, wrong pixel format) and ADR-007's UI-thread freeze
(a fire-and-forget async loop that could spin forever with no yield
point), the pattern was clear: every one of this project's screen-share
bugs came from hand-reimplementing a production-grade protocol (WebRTC)
on top of a thin, sparsely-maintained C# wrapper around libvpx, with no
congestion control, no NACK/PLI/FEC, no simulcast, and (per ADR-008) no
working rate control at all.

**What was verified before deciding:** `Microsoft.MixedReality.WebRTC`
(Microsoft's own C# libwebrtc wrapper) was archived in March 2022 and is
unmaintained — not a viable replacement wrapper. Community C# wrappers
(`webrtc-dotnet-core`, `WebRtc.NET`) exist but are small, individually
maintained projects — swapping one thin/fragile wrapper for another was
judged not worth the risk. LiveKit (a well-maintained SFU) has no
first-party .NET **client** SDK — `Livekit.Rtc.Dotnet` is scoped to
server-side participants (bots/recording), not a desktop UI. Meanwhile
`client/native/Talkeando.Client` already embeds a full Chromium engine via
WebView2 for its UI — and Chromium's own libwebrtc (the same engine behind
Meet/Discord's web client) is therefore already present, fully maintained
by Google/Microsoft, with real GCC bandwidth estimation, real
rate-controlled VP8/VP9/H264 encode, real NACK/PLI/FEC, simulcast/SVC, and
screen-content coding — all of it "for free" via the standard
`RTCPeerConnection`/`getUserMedia`/`getDisplayMedia` JS APIs. Confirmed the
pinned WebView2 SDK (`Microsoft.Web.WebView2` 1.0.3485.44) already
supports the needed `CoreWebView2.PermissionRequested` and
`ScreenCaptureStarting` APIs — no SDK bump required.

**Decision:** move the entire WebRTC media pipeline into
`client/ui/src/rtc.ts`, running on the browser's native
`RTCPeerConnection`. The native C# side (`IpcBridge.cs`) becomes a pure
signaling relay: `call.join`/`call.leave`/`call.state.update`/
`stream.publish`/`stream.unpublish`/`stream.subscribe`/`stream.unsubscribe`/
`rtc.offer`/`rtc.answer`/`rtc.ice` all pass straight through to the
authenticated WebSocket with no parsing beyond the envelope, and every WS
event is forwarded to the UI unchanged (`Publish(op, data)`) as before —
`IpcBridge` no longer needs to know these ops exist. A new pass-through op,
`rtc.turn_credentials.request` / `rtc.turn_credentials`, lets `rtc.ts` ask
the native side for fresh ephemeral TURN credentials (still an HTTP call
only the native side can make, since it holds the bearer token) without
`IpcBridge` needing to understand what they're for.

**Topology is unchanged:** still one `RTCPeerConnection` per remote
participant (mesh), still P2P with TURN only as an ICE-fallback relay —
nothing here introduces an SFU or any central media server. Offerer
election is still "the lower user id offers first," ICE-restart-on-degrade
is still "only the lower id restarts," and the screen-share send-side
subscription gate (`sender.replaceTrack(track | null)`, never renegotiate
the video m-line) all carry over unchanged in spirit from the old
`RtcEngine.cs` — only the implementation language changed, from C#/
SIPSorcery calls to TypeScript calls on the same browser API surface every
other WebRTC app in the world uses.

**What was removed:** `RtcEngine.cs`, `ScreenShareViewerWindow.xaml(.cs)`,
`RtcEngineTests.cs`, and the `SIPSorcery`/`SIPSorceryMedia.Windows`/
`SIPSorceryMedia.Encoders` package references (and, with them,
`System.Windows.Forms`/GDI screen capture, `vpxmd.dll`, and the whole
BGR/BGRA pixel-format class of bug from ADR-005). The custom native
monitor-picker UI (`screen.sources.list`, `MonitorInfo`) is also gone —
`getDisplayMedia()` shows Chromium's own built-in source picker instead;
per-monitor pre-selection from the app's own UI is no longer possible
without the `ScreenCaptureStarting` host hook, which was not implemented
in this pass (noted as a known UX regression, not a bug).

**Consequences:**
- No native C# unit-test coverage of call/screen-share logic remains
  (`RtcEngineTests.cs` tested `RtcEngine` directly; that class no longer
  exists). `rtc.ts`'s logic is not covered by any automated test in this
  pass — a real gap, since testing `RTCPeerConnection` behavior needs a
  browser test environment this project does not yet have.
- Remote audio/video rendering is now plain `<audio>`/`<video>` elements
  with `srcObject` assignment — this retires the entire native
  `ScreenShareViewerWindow` bitmap-blitting pipeline (and every stride/
  pixel-format bug that came with it) in favor of the browser's own
  hardware-accelerated decode path.
- Any future screen-share UX work (custom monitor selection, in-app
  picker) needs `CoreWebView2.ScreenCaptureStarting`, not a native GDI
  monitor list — a materially different mechanism than what
  `27-decisions.md` previously documented for ADR-003.
