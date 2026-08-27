using Microsoft.Web.WebView2.Core;
using SIPSorcery.Net;
using System.Text.Json;

namespace Talkeando.Client;

/// Sole native/UI boundary. Commands are envelope-shaped (`op`, `data`) and
/// every response is posted back as an event envelope, so the React UI never
/// sees session secrets or native WebRTC objects.
public sealed class IpcBridge : IDisposable
{
    public event EventHandler<string>? EventReady;
    private readonly SessionStore _sessions = new();
    private readonly NetworkClient _network;
    private readonly RtcEngine _rtc = new();
    private readonly Dictionary<Guid, ScreenShareViewerWindow> _watchWindows = new();
    /// stream_id -> owner user_id, learned from `stream.published` — needed
    /// because `stream.unpublished` only carries `stream_id` (see
    /// server/src/ws/protocol.rs `StreamUnpublished`), not who owned it.
    private readonly Dictionary<Guid, Guid> _streamOwners = new();
    private Guid? _currentCallChannel;
    private Guid? _currentUser;

    private readonly Dictionary<Guid, CancellationTokenSource> _iceRestartTimers = new();

    public IpcBridge()
    {
        _network = new NetworkClient(_sessions);
        _rtc.IceCandidateReady += (peerUserId, candidate) => _ = SendIceAsync(peerUserId, candidate);
        // v1 simplification: a peer publishes at most one screen share at a
        // time (see SDD/30-v1-delivery-plan.md M1.3), so routing decoded
        // frames by peerUserId alone (not by stream_id) is sufficient.
        _rtc.RemoteVideoFrameReceived += (peerUserId, width, height, bgra) =>
        {
            if (_watchWindows.TryGetValue(peerUserId, out var window))
                window.UpdateFrame(width, height, bgra);
        };
        _rtc.ConnectionStateChanged += (peerUserId, state) => _ = HandleConnectionStateChangeAsync(peerUserId, state);
    }

    /// flows/reconnect.md layer 2 (peer WebRTC reconnect): only the
    /// deterministically "lower id" side initiates ICE restart — the same
    /// convention already used to decide who offers first on a fresh
    /// connection — so both ends of a degraded link do not restart ICE at
    /// the same time and race each other (a scoped simplification, not full
    /// Perfect Negotiation collision recovery — see SDD/27-decisions.md).
    private async Task HandleConnectionStateChangeAsync(Guid peerUserId, RTCPeerConnectionState state)
    {
        if (_iceRestartTimers.Remove(peerUserId, out var previous)) previous.Cancel();
        if (_currentUser is not Guid self || self.CompareTo(peerUserId) >= 0) return;

        if (state == RTCPeerConnectionState.disconnected)
        {
            // "disconnected" is often transient (a brief packet-loss burst);
            // give it a grace period before treating it as real network
            // failure, per flows/reconnect.md.
            var cts = new CancellationTokenSource();
            _iceRestartTimers[peerUserId] = cts;
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(5), cts.Token);
                await TriggerIceRestartAsync(peerUserId);
            }
            catch (OperationCanceledException) { /* recovered before the grace period elapsed */ }
        }
        else if (state == RTCPeerConnectionState.failed)
        {
            await TriggerIceRestartAsync(peerUserId);
        }
    }

    private async Task TriggerIceRestartAsync(Guid peerUserId)
    {
        if (_currentCallChannel is not Guid channelId) return;
        try
        {
            var sdp = await _rtc.RestartIceAsync(peerUserId);
            await _network.SendWebSocketAsync("rtc.offer", JsonSerializer.SerializeToElement(new { channel_id = channelId, to = peerUserId, sdp }));
        }
        catch (Exception exception)
        {
            Publish("error", new { code = "ice_restart_failed", message = exception.Message });
        }
    }

    public async void HandleWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        // Temporary diagnostic logging (2026-08-27): tracking down a
        // "clicking login does nothing, no errors" report. Console.WriteLine
        // — not Debug.WriteLine — because this needs to be visible in the
        // terminal `dotnet run` was launched from, not just a debugger.
        Console.WriteLine($"[IPC] received: {args.WebMessageAsJson}");
        try
        {
            using var document = JsonDocument.Parse(args.WebMessageAsJson);
            var root = document.RootElement;
            var op = root.GetProperty("op").GetString();
            Console.WriteLine($"[IPC] dispatching op={op}");
            switch (op)
            {
                case "auth.session.restore":
                    if (!_sessions.HasToken) { Publish("auth.state_changed", new { state = "logged_out" }); break; }
                    await PublishBootstrapAsync();
                    break;
                case "auth.login":
                    await _network.LoginAsync(root.GetProperty("data"));
                    await PublishBootstrapAsync();
                    break;
                case "auth.register":
                    await _network.RegisterAsync(root.GetProperty("data"));
                    await PublishBootstrapAsync();
                    break;
                case "auth.session.clear":
                    _sessions.Clear();
                    Publish("auth.state_changed", new { state = "logged_out" });
                    break;
                case "chat.history.load":
                    var channelId = root.GetProperty("data").GetProperty("channel_id").GetGuid();
                    var history = await _network.HistoryAsync(channelId);
                    Publish("chat.history", history);
                    break;
                case "attachment.upload":
                    var attachmentData = root.GetProperty("data");
                    var attachmentChannel = attachmentData.GetProperty("channel_id").GetGuid();
                    var attachmentPath = attachmentData.GetProperty("file_path").GetString()
                        ?? throw new InvalidOperationException("Arquivo não informado.");
                    Publish("attachment.uploaded", await _network.UploadAttachmentAsync(attachmentChannel, attachmentPath));
                    break;
                case "attachment.pick":
                    var selectedChannel = root.GetProperty("data").GetProperty("channel_id").GetGuid();
                    var picker = new Microsoft.Win32.OpenFileDialog { Title = "Selecionar anexo" };
                    if (picker.ShowDialog() == true)
                        Publish("attachment.uploaded", await _network.UploadAttachmentAsync(selectedChannel, picker.FileName));
                    else
                        Publish("attachment.cancelled", new { });
                    break;
                case "attachment.open":
                    var openData = root.GetProperty("data");
                    await _network.OpenAttachmentAsync(
                        openData.GetProperty("attachment_id").GetGuid(),
                        openData.GetProperty("filename").GetString() ?? "attachment"
                    );
                    break;
                case "call.join":
                    await _network.SendWebSocketAsync(op!, root.GetProperty("data"));
                    await _rtc.StartMicrophoneAsync();
                    break;
                case "call.leave":
                    await _network.SendWebSocketAsync(op!, root.GetProperty("data"));
                    await _rtc.LeaveCallAsync();
                    _currentCallChannel = null;
                    break;
                case "call.state.update":
                    var stateData = root.GetProperty("data");
                    if (stateData.TryGetProperty("muted", out var mutedEl) && mutedEl.ValueKind is JsonValueKind.True or JsonValueKind.False)
                        _rtc.SetMuted(mutedEl.GetBoolean());
                    if (stateData.TryGetProperty("deafened", out var deafenedEl) && deafenedEl.ValueKind is JsonValueKind.True or JsonValueKind.False)
                        _rtc.SetDeafened(deafenedEl.GetBoolean());
                    await _network.SendWebSocketAsync(op!, stateData);
                    break;
                case "screen.sources.list":
                    Publish("screen.sources", RtcEngine.ListMonitors());
                    break;
                case "stream.publish":
                    var publishData = root.GetProperty("data");
                    var streamId = publishData.GetProperty("stream_id").GetGuid();
                    // `monitor_index` is native-only (selects which GDI
                    // screen to capture) and is not part of the server's
                    // stream.publish contract, so it is read here and not
                    // forwarded over the WebSocket.
                    var monitorIndex = publishData.TryGetProperty("monitor_index", out var monitorEl) ? monitorEl.GetInt32() : 0;
                    _rtc.PublishScreen(streamId, monitorIndex);
                    await _network.SendWebSocketAsync(op!, publishData);
                    break;
                case "stream.unpublish":
                    var unpublishStreamId = root.GetProperty("data").GetProperty("stream_id").GetGuid();
                    _rtc.UnpublishScreen(unpublishStreamId);
                    await _network.SendWebSocketAsync(op!, root.GetProperty("data"));
                    break;
                case "stream.watch":
                    var watchData = root.GetProperty("data");
                    var watchOwner = watchData.GetProperty("owner_user_id").GetGuid();
                    if (!_watchWindows.ContainsKey(watchOwner))
                    {
                        var window = new ScreenShareViewerWindow { Title = $"Talkeando — assistindo {watchOwner}" };
                        // Closing the window (either via the "x" button or
                        // from the stream.stop_watching case below) is the
                        // single place that both forgets the window and
                        // tells the server to stop this subscription — no
                        // duplicate unsubscribe path to drift out of sync.
                        window.Closed += (_, _) =>
                        {
                            _watchWindows.Remove(watchOwner);
                            _ = _network.SendWebSocketAsync("stream.unsubscribe", watchData);
                        };
                        _watchWindows[watchOwner] = window;
                        window.Show();
                    }
                    await _network.SendWebSocketAsync("stream.subscribe", watchData);
                    break;
                case "stream.stop_watching":
                    var stopOwner = root.GetProperty("data").GetProperty("owner_user_id").GetGuid();
                    if (_watchWindows.TryGetValue(stopOwner, out var watchWindow)) watchWindow.Close();
                    else await _network.SendWebSocketAsync("stream.unsubscribe", root.GetProperty("data"));
                    break;
                case "chat.message.create":
                case "chat.message.edit":
                case "chat.message.delete":
                case "chat.typing":
                    await _network.SendWebSocketAsync(op!, root.GetProperty("data"));
                    break;
                default:
                    Publish("error", new { code = "unknown_ipc_op", op });
                    break;
            }
        }
        catch (Exception exception)
        {
            Publish("error", new { code = "ipc_request_failed", message = exception.Message });
        }
    }

    private async Task PublishBootstrapAsync()
    {
        var bootstrap = await _network.BootstrapAsync();
        _currentUser = bootstrap.GetProperty("currentUser").GetProperty("id").GetGuid();
        await _network.ConnectWebSocketAsync(HandleNetworkEvent);
        Publish("app.bootstrap", bootstrap);
        Publish("auth.state_changed", new { state = "authenticated" });
    }

    private void HandleNetworkEvent(string op, JsonElement data)
    {
        try
        {
            if (op == "call.snapshot")
            {
                var channel = data.GetProperty("channel_id").GetGuid();
                _currentCallChannel = channel;
                if (_currentUser is Guid self)
                {
                    foreach (var participant in data.GetProperty("participants").EnumerateArray())
                    {
                        var peer = participant.GetProperty("user_id").GetGuid();
                        if (self != peer && self.CompareTo(peer) < 0) _ = OfferRtcAsync(channel, peer);
                    }
                }
            }
            else if (op == "call.peer_left")
            {
                var departedPeer = data.GetProperty("user_id").GetGuid();
                _rtc.RemovePeer(departedPeer);
                CloseWatchWindow(departedPeer);
            }
            else if (op == "stream.published")
            {
                _streamOwners[data.GetProperty("stream_id").GetGuid()] = data.GetProperty("owner").GetGuid();
            }
            else if (op == "stream.unpublished")
            {
                // Owner stopped sharing (or left the call, which the server
                // also reports as stream.unpublished per channel_id cleanup)
                // — nothing more will ever arrive for this stream.
                var unpublishedStreamId = data.GetProperty("stream_id").GetGuid();
                if (_streamOwners.Remove(unpublishedStreamId, out var owner)) CloseWatchWindow(owner);
            }
            else if (op == "rtc.offer")
            {
                _ = AnswerRtcOfferAsync(data);
            }
            else if (op == "rtc.answer")
            {
                _rtc.AcceptAnswer(data.GetProperty("from").GetGuid(), data.GetProperty("sdp").GetString() ?? String.Empty);
            }
            else if (op == "rtc.ice")
            {
                var candidate = data.GetProperty("candidate").Deserialize<RTCIceCandidateInit>();
                if (candidate is not null) _rtc.AddIceCandidate(data.GetProperty("from").GetGuid(), candidate);
            }
            else if (op == "call.peer_joined" && _currentCallChannel is Guid channel && _currentUser is Guid self)
            {
                var peer = data.GetProperty("participant").GetProperty("user_id").GetGuid();
                if (self.CompareTo(peer) < 0) _ = OfferRtcAsync(channel, peer);
            }
            // SUB-FR-001: these two ops are only ever routed to the stream's
            // *owner* by the server (see ws/handler.rs handle_stream_subscribe/
            // unsubscribe) — receiving one here means this client must start
            // or stop sending that stream's video to the named peer.
            else if (op == "stream.subscription_requested")
            {
                _rtc.SetScreenSubscription(data.GetProperty("stream_id").GetGuid(), data.GetProperty("subscriber").GetGuid(), subscribed: true);
            }
            else if (op == "stream.unsubscribed")
            {
                _rtc.SetScreenSubscription(data.GetProperty("stream_id").GetGuid(), data.GetProperty("subscriber").GetGuid(), subscribed: false);
            }
        }
        catch (Exception exception)
        {
            Publish("error", new { code = "rtc_signal_failed", message = exception.Message });
        }
        Publish(op, data);
    }

    private async Task OfferRtcAsync(Guid channelId, Guid peerUserId)
    {
        var sdp = await _rtc.CreateOfferAsync(peerUserId, await _network.GetTurnCredentialsAsync());
        await _network.SendWebSocketAsync("rtc.offer", JsonSerializer.SerializeToElement(new { channel_id = channelId, to = peerUserId, sdp }));
    }

    private async Task AnswerRtcOfferAsync(JsonElement data)
    {
        var channelId = data.GetProperty("channel_id").GetGuid();
        var peerUserId = data.GetProperty("from").GetGuid();
        var sdp = await _rtc.AcceptOfferAsync(peerUserId, await _network.GetTurnCredentialsAsync(), data.GetProperty("sdp").GetString() ?? String.Empty);
        await _network.SendWebSocketAsync("rtc.answer", JsonSerializer.SerializeToElement(new { channel_id = channelId, to = peerUserId, sdp }));
    }

    private async Task SendIceAsync(Guid peerUserId, RTCIceCandidate candidate)
    {
        if (_currentCallChannel is not Guid channelId) return;
        await _network.SendWebSocketAsync("rtc.ice", JsonSerializer.SerializeToElement(new
        {
            channel_id = channelId,
            to = peerUserId,
            candidate = new { candidate = candidate.candidate, sdpMid = candidate.sdpMid, sdpMLineIndex = candidate.sdpMLineIndex },
        }));
    }

    private void CloseWatchWindow(Guid ownerUserId)
    {
        if (_watchWindows.TryGetValue(ownerUserId, out var window)) window.Close();
    }

    public void Publish(string op, object data) =>
        EventReady?.Invoke(this, JsonSerializer.Serialize(new { v = 1, op, data }));

    public void Dispose()
    {
        foreach (var window in _watchWindows.Values.ToArray()) window.Close();
        _rtc.Dispose();
    }
}
