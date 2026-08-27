using System.Collections.Concurrent;
using SIPSorcery.Media;
using SIPSorcery.Net;
using SIPSorceryMedia.Abstractions;
using SIPSorceryMedia.Encoders;
using SIPSorceryMedia.Windows;

namespace Talkeando.Client;

/// One monitor available for screen sharing (`ListMonitors`/`screen.sources.list`).
public sealed record MonitorInfo(int Index, string DeviceName, bool IsPrimary, int Width, int Height);

/// One RTCPeerConnection per remote call participant (mesh voice). Signaling is
/// deliberately kept outside this class: IpcBridge owns the authenticated
/// WebSocket and transports the SDP/ICE payloads to the Talkeando server.
///
/// Codec note: SIPSorcery's bundled `SIPSorcery.Media.AudioEncoder` does not
/// implement Opus (verified by reflecting its `SupportedFormats`: PCMU, PCMA,
/// G722, G729 only — no native Opus wrapper ships with the core package on
/// this .NET 6 / SIPSorcery 6.2.4 toolchain). G722 is the wideband option in
/// that set (16 kHz, no extra native dependency), so it is the v1 codec
/// instead of Opus — see SDD/13-audio-pipeline.md for the corrected decision.
/// Every peer and the shared microphone source restrict to G722 so the whole
/// mesh negotiates the same codec.
///
/// Screen share video codec is VP8 via `SIPSorceryMedia.Encoders.VpxVideoEncoder`
/// (a libvpx wrapper, verified present and API-compatible at the pinned
/// SIPSorcery 6.x line — see `27-decisions.md` ADR-003). Capture uses GDI
/// (`System.Drawing`/`System.Windows.Forms.Screen`), not
/// `Windows.Graphics.Capture`: ADR-003 also covers why — WGC needs WinRT COM
/// interop this session could not validate at runtime (no capturable
/// display in the build environment), whereas GDI `CopyFromScreen` is a
/// mature, simple API. This trades away per-window capture and occlusion
/// awareness for v1; whole-monitor selection is supported.
public sealed class RtcEngine : IDisposable
{
    private sealed class PublishedScreenShare
    {
        public WindowsVideoEndPoint Endpoint = null!;
        public CancellationTokenSource Cts = null!;
        public readonly ConcurrentDictionary<Guid, byte> Subscribers = new();
    }

    private readonly ConcurrentDictionary<Guid, RTCPeerConnection> _peers = new();
    private readonly ConcurrentDictionary<Guid, WindowsAudioEndPoint> _audioSinks = new();
    private readonly ConcurrentDictionary<Guid, VpxVideoEncoder> _videoDecoders = new();

    /// Keyed by streamId (SCREEN-FR: one publish = one `PublishedStream`).
    /// Screen capture only starts on an explicit `PublishScreen` call and
    /// stops on `UnpublishScreen` — unlike the microphone it is not tied to
    /// call join/leave, since sharing is a separate opt-in action.
    private readonly ConcurrentDictionary<Guid, PublishedScreenShare> _screenShares = new();

    /// Captured once and fanned out to every connected peer — a mesh must not
    /// open one WASAPI capture session per remote participant.
    private readonly WindowsAudioEndPoint _microphone;
    private bool _microphoneStarted;
    private bool _muted = true;
    private bool _deafened;

    public event Action<Guid, RTCIceCandidate>? IceCandidateReady;
    public event Action<Guid, RTCPeerConnectionState>? ConnectionStateChanged;

    /// Decoded remote screen/camera frame: (fromPeerUserId, width, height,
    /// BGRA bytes). No rendering surface is wired to this yet — see
    /// SDD/31-implementation-status.md for the pending UI task.
    public event Action<Guid, uint, uint, byte[]>? RemoteVideoFrameReceived;

    public RtcEngine()
    {
        _microphone = new WindowsAudioEndPoint(new AudioEncoder(false), -1, -1, disableSource: false, disableSink: true);
        _microphone.RestrictFormats(IsG722);
        _microphone.OnAudioSourceEncodedSample += (durationRtpUnits, sample) =>
        {
            if (_muted || _deafened) return;
            foreach (var peer in _peers.Values)
            {
                if (peer.connectionState == RTCPeerConnectionState.connected)
                    peer.SendAudio(durationRtpUnits, sample);
            }
        };
    }

    private static bool IsG722(AudioFormat format) => format.Codec == AudioCodecsEnum.G722;

    public RTCPeerConnection GetOrCreatePeer(Guid peerUserId, TurnCredentials turn)
    {
        return _peers.GetOrAdd(peerUserId, _ =>
        {
            var configuration = new RTCConfiguration
            {
                iceServers = turn.Uris.Select(uri => new RTCIceServer
                {
                    urls = uri,
                    username = turn.Username,
                    credential = turn.Credential,
                }).ToList(),
            };
            var peer = new RTCPeerConnection(configuration);
            // Each remote peer gets its own playback sink; the microphone
            // (capture) side is shared and owned by this engine, not by any
            // one peer's endpoint, so it is disabled here.
            var audioSink = new WindowsAudioEndPoint(new AudioEncoder(false), -1, -1, disableSource: true, disableSink: false);
            audioSink.RestrictFormats(IsG722);
            _audioSinks[peerUserId] = audioSink;
            peer.addTrack(new MediaStreamTrack(audioSink.GetAudioSinkFormats(), MediaStreamStatusEnum.SendRecv));
            peer.OnAudioFormatsNegotiated += formats =>
            {
                // AudioFormat is a struct: FirstOrDefault() never returns
                // null, it returns default(AudioFormat) when empty, so guard
                // on Count instead of a null check.
                if (formats.Count == 0) return;
                var format = formats[0];
                audioSink.SetAudioSinkFormat(format);
                // All peers must land on the same source format since one
                // microphone capture is shared across every PeerConnection
                // (see class remarks) — every peer negotiates G722 so this is
                // idempotent in practice, not a per-peer switch.
                _microphone.SetAudioSourceFormat(format);
            };
            peer.OnRtpPacketReceived += (remote, mediaType, packet) =>
            {
                if (mediaType != SDPMediaTypesEnum.audio || _deafened) return;
                audioSink.GotAudioRtp(remote, packet.Header.SyncSource, packet.Header.SequenceNumber,
                    packet.Header.Timestamp, packet.Header.PayloadType, packet.Header.MarkerBit == 1, packet.Payload);
            };
            // Single VP8-only video m-line per peer, added once and never
            // renegotiated afterward — screen share subscribe/unsubscribe is
            // implemented as a send-side gate (see PublishScreen/
            // SetScreenSubscription below), exactly like mute, specifically
            // to avoid a renegotiation storm on every subscribe/unsubscribe
            // (see SDD/12-stream-subscription-model.md).
            peer.addTrack(new MediaStreamTrack(new VideoFormat(VideoCodecsEnum.VP8, 96, 90000, string.Empty), MediaStreamStatusEnum.SendRecv));
            peer.OnVideoFrameReceived += (_, _, payload, format) =>
            {
                var decoder = _videoDecoders.GetOrAdd(peerUserId, _ => new VpxVideoEncoder());
                foreach (var sample in decoder.DecodeVideo(payload, VideoPixelFormatsEnum.Bgra, format.Codec))
                    RemoteVideoFrameReceived?.Invoke(peerUserId, sample.Width, sample.Height, sample.Sample);
            };
            peer.onicecandidate += candidate =>
            {
                if (candidate is not null) IceCandidateReady?.Invoke(peerUserId, candidate);
            };
            peer.onconnectionstatechange += async state =>
            {
                ConnectionStateChanged?.Invoke(peerUserId, state);
                if (state == RTCPeerConnectionState.connected) await audioSink.StartAudioSink();
                if (state is RTCPeerConnectionState.closed or RTCPeerConnectionState.failed) await audioSink.CloseAudio();
            };
            return peer;
        });
    }

    /// Starts the shared microphone capture. Called when the local user joins
    /// a voice call (not per-peer) so mic access is only held while a call is
    /// active — see SDD/13-audio-pipeline.md privacy note.
    public async Task StartMicrophoneAsync()
    {
        if (_microphoneStarted) return;
        _microphoneStarted = true;
        await _microphone.StartAudio();
    }

    /// Tears down every peer in the call and stops the microphone. Server
    /// broadcasts `call.peer_left` to the *other* participants on
    /// `call.leave`, but the leaving client itself is responsible for closing
    /// its own PeerConnections (see flows/leave-call.md).
    public async Task LeaveCallAsync()
    {
        foreach (var peerUserId in _peers.Keys.ToArray())
            RemovePeer(peerUserId);
        if (_microphoneStarted)
        {
            _microphoneStarted = false;
            await _microphone.CloseAudio();
        }
    }

    /// Exposed read-only for tests and for any future UI that needs to
    /// reflect actual engine state rather than trust its own last command.
    public bool IsMuted => _muted;
    public bool IsDeafened => _deafened;

    /// AUDIO-FR: local mute — stops outgoing RTP without tearing down any
    /// PeerConnection or renegotiating.
    public void SetMuted(bool muted) => _muted = muted;

    /// AUDIO-FR: local deafen — also stops rendering incoming audio. Mirrors
    /// common voice-chat semantics where deafened implies muted for send
    /// (you cannot coordinate un-muting while you can't hear), without
    /// forgetting the user's own mute preference: `_muted` itself is left
    /// untouched, `SetMuted`'s caller (IpcBridge) restores the correct value
    /// when undeafening.
    public void SetDeafened(bool deafened) => _deafened = deafened;

    public bool HasPeer(Guid peerUserId) => _peers.ContainsKey(peerUserId);

    public bool IsStreamPublished(Guid streamId) => _screenShares.ContainsKey(streamId);

    public bool HasSubscriber(Guid streamId, Guid subscriberUserId) =>
        _screenShares.TryGetValue(streamId, out var share) && share.Subscribers.ContainsKey(subscriberUserId);

    public async Task<string> CreateOfferAsync(Guid peerUserId, TurnCredentials turn)
    {
        var peer = GetOrCreatePeer(peerUserId, turn);
        var offer = peer.createOffer();
        await peer.setLocalDescription(offer);
        return offer.sdp;
    }

    /// RTC-FR (reconexão): resets the ICE agent on an existing
    /// PeerConnection and produces a fresh offer carrying new ICE
    /// credentials — SIPSorcery's `restartIce()` does not itself return an
    /// SDP or renegotiate; the caller still runs the normal offer/answer
    /// exchange over the existing signaling channel. Throws if the peer
    /// connection was never created (caller should not restart ICE on a
    /// peer that was never connected).
    public async Task<string> RestartIceAsync(Guid peerUserId)
    {
        if (!_peers.TryGetValue(peerUserId, out var peer))
            throw new InvalidOperationException("Peer RTC não encontrado para restart de ICE.");
        peer.restartIce();
        var offer = peer.createOffer();
        await peer.setLocalDescription(offer);
        return offer.sdp;
    }

    public async Task<string> AcceptOfferAsync(Guid peerUserId, TurnCredentials turn, string remoteSdp)
    {
        var peer = GetOrCreatePeer(peerUserId, turn);
        var result = peer.setRemoteDescription(new RTCSessionDescriptionInit
        {
            type = RTCSdpType.offer,
            sdp = remoteSdp,
        });
        if (result != SetDescriptionResultEnum.OK) throw new InvalidOperationException($"Oferta RTC inválida: {result}.");
        var answer = peer.createAnswer();
        await peer.setLocalDescription(answer);
        return answer.sdp;
    }

    public void AcceptAnswer(Guid peerUserId, string remoteSdp)
    {
        if (!_peers.TryGetValue(peerUserId, out var peer)) throw new InvalidOperationException("Peer RTC não encontrado.");
        var result = peer.setRemoteDescription(new RTCSessionDescriptionInit { type = RTCSdpType.answer, sdp = remoteSdp });
        if (result != SetDescriptionResultEnum.OK) throw new InvalidOperationException($"Resposta RTC inválida: {result}.");
    }

    public void AddIceCandidate(Guid peerUserId, RTCIceCandidateInit candidate)
    {
        if (_peers.TryGetValue(peerUserId, out var peer)) peer.addIceCandidate(candidate);
    }

    public void RemovePeer(Guid peerUserId)
    {
        if (_peers.TryRemove(peerUserId, out var peer)) peer.close();
        if (_audioSinks.TryRemove(peerUserId, out var audioSink)) _ = audioSink.CloseAudio();
        if (_videoDecoders.TryRemove(peerUserId, out var decoder)) decoder.Dispose();
        // A departed peer can no longer be a viewer of anything this client
        // is sharing — mirrors the server's CallRegistry.leave semantics.
        foreach (var share in _screenShares.Values) share.Subscribers.TryRemove(peerUserId, out _);
    }

    public static IReadOnlyList<MonitorInfo> ListMonitors() =>
        System.Windows.Forms.Screen.AllScreens
            .Select((screen, index) => new MonitorInfo(index, screen.DeviceName, screen.Primary, screen.Bounds.Width, screen.Bounds.Height))
            .ToList();

    /// SCREEN-FR-001/SUB-FR-001: capture starts immediately (the user chose
    /// to share), but zero bytes are sent to anyone until each viewer's
    /// `stream.subscribe` arrives via `SetScreenSubscription` — the encoded
    /// sample handler below only sends to peers present in `Subscribers`.
    public void PublishScreen(Guid streamId, int monitorIndex, int fps = 15)
    {
        if (_screenShares.ContainsKey(streamId)) return;
        var screens = System.Windows.Forms.Screen.AllScreens;
        if (monitorIndex < 0 || monitorIndex >= screens.Length)
            throw new ArgumentOutOfRangeException(nameof(monitorIndex), "Monitor selecionado não existe.");
        var bounds = screens[monitorIndex].Bounds;

        var endpoint = new WindowsVideoEndPoint(new VpxVideoEncoder(), string.Empty, 0, 0, 0);
        endpoint.RestrictFormats(format => format.Codec == VideoCodecsEnum.VP8);
        var cts = new CancellationTokenSource();
        var share = new PublishedScreenShare { Endpoint = endpoint, Cts = cts };

        endpoint.OnVideoSourceEncodedSample += (durationRtpUnits, sample) =>
        {
            foreach (var subscriberId in share.Subscribers.Keys)
            {
                if (_peers.TryGetValue(subscriberId, out var peer) && peer.connectionState == RTCPeerConnectionState.connected)
                    peer.SendVideo(durationRtpUnits, sample);
            }
        };

        _screenShares[streamId] = share;
        _ = CaptureScreenLoopAsync(bounds, endpoint, fps, cts.Token);
    }

    private static async Task CaptureScreenLoopAsync(System.Drawing.Rectangle bounds, WindowsVideoEndPoint endpoint, int fps, CancellationToken token)
    {
        // VP8's RTP clock rate is fixed at 90kHz regardless of actual frame
        // rate (verified via VpxVideoEncoder.SupportedFormats) — this is the
        // per-frame duration in RTP units, not a codec/fps-dependent value.
        var durationRtpUnits = (uint)(90000 / Math.Max(1, fps));
        var frameInterval = TimeSpan.FromMilliseconds(1000.0 / Math.Max(1, fps));
        using var bitmap = new System.Drawing.Bitmap(bounds.Width, bounds.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        while (!token.IsCancellationRequested)
        {
            var frameStart = DateTime.UtcNow;
            try
            {
                using (var graphics = System.Drawing.Graphics.FromImage(bitmap))
                    graphics.CopyFromScreen(bounds.Location, System.Drawing.Point.Empty, bounds.Size);

                var bits = bitmap.LockBits(
                    new System.Drawing.Rectangle(0, 0, bounds.Width, bounds.Height),
                    System.Drawing.Imaging.ImageLockMode.ReadOnly,
                    System.Drawing.Imaging.PixelFormat.Format32bppArgb);
                try
                {
                    var buffer = new byte[bits.Stride * bits.Height];
                    System.Runtime.InteropServices.Marshal.Copy(bits.Scan0, buffer, 0, buffer.Length);
                    endpoint.ExternalVideoSourceRawSample(durationRtpUnits, bounds.Width, bounds.Height, buffer, VideoPixelFormatsEnum.Bgra);
                }
                finally { bitmap.UnlockBits(bits); }
            }
            catch
            {
                // Monitor disconnected mid-share, or a transient GDI failure
                // (SCREEN-FR: "source desapareceu") — stop this capture loop
                // rather than spin; the publisher must call PublishScreen
                // again (a fresh stream) once the source is available.
                break;
            }

            var remaining = frameInterval - (DateTime.UtcNow - frameStart);
            if (remaining > TimeSpan.Zero)
            {
                try { await Task.Delay(remaining, token); }
                catch (OperationCanceledException) { break; }
            }
        }
    }

    public void UnpublishScreen(Guid streamId)
    {
        if (!_screenShares.TryRemove(streamId, out var share)) return;
        share.Cts.Cancel();
        _ = share.Endpoint.CloseVideo();
        share.Endpoint.Dispose();
    }

    /// Driven by `stream.subscription_requested` (subscribed=true) and
    /// `stream.unsubscribed` (subscribed=false) arriving over the WebSocket
    /// for a stream this client owns — see IpcBridge.
    public void SetScreenSubscription(Guid streamId, Guid subscriberUserId, bool subscribed)
    {
        if (!_screenShares.TryGetValue(streamId, out var share)) return;
        if (subscribed) share.Subscribers[subscriberUserId] = 0;
        else share.Subscribers.TryRemove(subscriberUserId, out _);
    }

    public void Dispose()
    {
        foreach (var streamId in _screenShares.Keys.ToArray()) UnpublishScreen(streamId);
        foreach (var peer in _peers.Values) peer.close();
        foreach (var audioSink in _audioSinks.Values) _ = audioSink.CloseAudio();
        foreach (var decoder in _videoDecoders.Values) decoder.Dispose();
        _peers.Clear();
        _audioSinks.Clear();
        _videoDecoders.Clear();
        _ = _microphone.CloseAudio();
    }
}

public sealed record TurnCredentials(string Username, string Credential, IReadOnlyList<string> Uris);
