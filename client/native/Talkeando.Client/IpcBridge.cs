using Microsoft.Web.WebView2.Core;
using System.Text.Json;

namespace Talkeando.Client;

/// Sole native/UI boundary. Commands are envelope-shaped (`op`, `data`) and
/// every response is posted back as an event envelope, so the React UI never
/// sees session secrets.
///
/// Call/screen-share signaling ops (`rtc.offer`/`rtc.answer`/`rtc.ice`,
/// `call.join`/`call.leave`/`call.state.update`, `stream.publish`/
/// `stream.unpublish`/`stream.subscribe`/`stream.unsubscribe`) are pure
/// passthrough to the authenticated WebSocket: this class no longer
/// understands WebRTC at all. The actual RTCPeerConnection mesh now runs in
/// the browser engine WebView2 already embeds (`client/ui/src/rtc.ts`) — see
/// SDD/27-decisions.md ADR-009 for why (ADR-008 found the pinned SIPSorcery
/// VP8 wrapper's bitrate control to be a no-op; real congestion
/// control/NACK/PLI/screen-content-coding all come free with the browser's
/// own libwebrtc instead of being reimplemented by hand). `rtc.offer`/
/// `rtc.answer`/`rtc.ice` and every WS event this client can receive are
/// forwarded to the UI unchanged by the catch-all `Publish(op, data)` in
/// `HandleNetworkEvent`.
public sealed class IpcBridge : IDisposable
{
    public event EventHandler<string>? EventReady;
    private readonly SessionStore _sessions = new();
    private readonly NetworkClient _network;

    public IpcBridge()
    {
        _network = new NetworkClient(_sessions);
    }

    public async void HandleWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        DebugLog.Write($"received: {args.WebMessageAsJson}");
        try
        {
            using var document = JsonDocument.Parse(args.WebMessageAsJson);
            var root = document.RootElement;
            var op = root.GetProperty("op").GetString();
            DebugLog.Write($"dispatching op={op}");
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
                // Everything below is a pure relay to the authenticated
                // WebSocket — the JS RTC engine (client/ui/src/rtc.ts) owns
                // all of the actual call/screen-share semantics now.
                case "call.join":
                case "call.leave":
                case "call.state.update":
                case "stream.publish":
                case "stream.unpublish":
                case "stream.subscribe":
                case "stream.unsubscribe":
                case "rtc.offer":
                case "rtc.answer":
                case "rtc.ice":
                case "chat.message.create":
                case "chat.message.edit":
                case "chat.message.delete":
                case "chat.typing":
                    await _network.SendWebSocketAsync(op!, root.GetProperty("data"));
                    break;
                case "rtc.turn_credentials.request":
                    var requestId = root.GetProperty("data").GetProperty("request_id").GetString();
                    var turn = await _network.GetTurnCredentialsAsync();
                    Publish("rtc.turn_credentials", new { request_id = requestId, username = turn.Username, credential = turn.Credential, uris = turn.Uris });
                    break;
                default:
                    Publish("error", new { code = "unknown_ipc_op", op });
                    break;
            }
        }
        catch (Exception exception)
        {
            DebugLog.Write($"FAILED: {exception}");
            Publish("error", new { code = "ipc_request_failed", message = exception.Message });
        }
    }

    private async Task PublishBootstrapAsync()
    {
        var bootstrap = await _network.BootstrapAsync();
        await _network.ConnectWebSocketAsync(HandleNetworkEvent);
        Publish("app.bootstrap", bootstrap);
        Publish("auth.state_changed", new { state = "authenticated" });
    }

    /// Every event the server sends over the WebSocket is forwarded to the
    /// UI verbatim — chat/presence ops are consumed by App.tsx, RTC signaling
    /// ops (`rtc.offer`/`rtc.answer`/`rtc.ice`, `call.snapshot`,
    /// `call.peer_joined`, `call.peer_left`, `stream.published`,
    /// `stream.unpublished`, `stream.subscription_requested`,
    /// `stream.unsubscribed`) are consumed by rtc.ts. This class does not
    /// need to understand which is which.
    private void HandleNetworkEvent(string op, JsonElement data) => Publish(op, data);

    public void Publish(string op, object data)
    {
        DebugLog.Write($"publishing to UI: op={op} hasSubscriber={EventReady is not null}");
        EventReady?.Invoke(this, JsonSerializer.Serialize(new { v = 1, op, data }));
    }

    public void Dispose() { }
}
