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
