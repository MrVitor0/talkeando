using Microsoft.Web.WebView2.Core;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Tupi.Client;

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

    /// Raised when the UI reports the active community name (`host.title`), so
    /// MainWindow's custom title bar can show it instead of a static string.
    public event EventHandler<string>? HostTitleChanged;

    /// Set by MainWindow once the WebView2 shared buffers exist: write one
    /// JPEG screen-capture frame / one PCM audio packet into `slot` of the
    /// respective shared buffer. Called from capture background threads.
    public Action<byte[], int>? WriteFrameSlot { get; set; }
    public Action<byte[], int>? WriteAudioSlot { get; set; }
    public int AudioSlotCount { get; set; } = 16;
    public uint BrowserProcessId { get; set; }

    private readonly SessionStore _sessions = new();
    private readonly NetworkClient _network;
    private readonly ScreenCapture _screen = new();
    private readonly AudioCapture _audio = new();
    private readonly ActivityMonitor _activity;
    private readonly UpdateChecker _updater = new();
    private readonly GlobalHotkeyHook _hotkey = new();
    private int _frameSeq;
    private int _audioSeq;

    public IpcBridge()
    {
        _network = new NetworkClient(_sessions);
        _hotkey.KeyEvent += (code, isDown) =>
        {
            Publish("hotkey.event", new { code, is_down = isDown });
        };
        // SDD/specs/activity.md: native watches SMTC + running games and
        // pushes `activity.report` straight to the authenticated WebSocket —
        // the UI only toggles it on/off via `activity.config`. Game icons are
        // uploaded to the content-addressed activity-asset store.
        _activity = new ActivityMonitor(
            payload => _network.SendWebSocketAsync("activity.report", JsonSerializer.SerializeToElement(payload)),
            (bytes, contentType) => _network.UploadActivityAssetAsync(bytes, contentType));
    }

    public async void HandleWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        string? op = null;
        string? requestId = null;
        try
        {
            using var document = JsonDocument.Parse(args.WebMessageAsJson);
            var root = document.RootElement;
            op = root.GetProperty("op").GetString();
            if (op == "chat.message.create"
                && root.TryGetProperty("data", out var requestData)
                && requestData.TryGetProperty("req_id", out var request))
                requestId = request.GetString();
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
                    await _network.DisconnectWebSocketAsync();
                    Publish("auth.state_changed", new { state = "logged_out" });
                    break;
                case "chat.history.load":
                {
                    // Tag the response with its channel so the UI can cache
                    // per channel and ignore a stale reply for one it left.
                    var channelId = root.GetProperty("data").GetProperty("channel_id").GetGuid();
                    var history = await _network.HistoryAsync(channelId);
                    var historyPayload = System.Text.Json.Nodes.JsonNode.Parse(history.GetRawText())!.AsObject();
                    historyPayload["channel_id"] = channelId.ToString();
                    Publish("chat.history", historyPayload);
                    break;
                }
                case "attachment.upload":
                    var attachmentData = root.GetProperty("data");
                    var attachmentChannel = attachmentData.GetProperty("channel_id").GetGuid();
                    var attachmentPath = attachmentData.GetProperty("file_path").GetString()
                        ?? throw new InvalidOperationException("Arquivo não informado.");
                    Publish("attachment.uploaded", await _network.UploadAttachmentAsync(attachmentChannel, attachmentPath));
                    break;
                case "attachment.upload_base64":
                {
                    var data = root.GetProperty("data");
                    var channelId = data.GetProperty("channel_id").GetGuid();
                    var base64 = data.GetProperty("base64").GetString() ?? throw new InvalidOperationException("Base64 não informado.");
                    var filename = data.TryGetProperty("filename", out var fn) && fn.ValueKind == JsonValueKind.String ? fn.GetString() ?? "imagem.png" : "imagem.png";
                    var contentType = data.TryGetProperty("content_type", out var ct) && ct.ValueKind == JsonValueKind.String ? ct.GetString() ?? "image/png" : "image/png";
                    var bytes = Convert.FromBase64String(base64);
                    Publish("attachment.uploaded", await _network.UploadAttachmentBytesAsync(channelId, bytes, filename, contentType));
                    break;
                }
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
                // ---- custom context-menu actions (rename / avatar) ----
                // The server persists and then broadcasts `member.updated` /
                // `channel.updated` over the WebSocket, which the catch-all
                // relay in HandleNetworkEvent forwards to the UI — so these
                // cases have nothing to publish back themselves.
                case "profile.rename":
                    await _network.UpdateDisplayNameAsync(RequiredString(root, "display_name"));
                    break;
                case "profile.update":
                {
                    var d = root.GetProperty("data");
                    string? displayName = d.TryGetProperty("display_name", out var dn) && dn.ValueKind == JsonValueKind.String ? dn.GetString() : null;
                    string? bio = d.TryGetProperty("bio", out var b) && b.ValueKind == JsonValueKind.String ? b.GetString() : null;
                    string? bannerPreset = d.TryGetProperty("banner_preset", out var bp) && bp.ValueKind == JsonValueKind.String ? bp.GetString() : null;
                    string? pronouns = d.TryGetProperty("pronouns", out var pr) && pr.ValueKind == JsonValueKind.String ? pr.GetString() : null;
                    string? nameColor = d.TryGetProperty("name_color", out var nc) && nc.ValueKind == JsonValueKind.String ? nc.GetString() : null;
                    await _network.UpdateProfileAsync(displayName, bio, bannerPreset, pronouns, nameColor);
                    break;
                }
                case "member.rename":
                {
                    var d = root.GetProperty("data");
                    await _network.RenameMemberAsync(d.GetProperty("user_id").GetGuid(), RequiredString(root, "display_name"));
                    break;
                }
                case "channel.rename":
                {
                    var d = root.GetProperty("data");
                    await _network.RenameChannelAsync(d.GetProperty("channel_id").GetGuid(), RequiredString(root, "name"));
                    break;
                }
                case "dm.open":
                {
                    var d = root.GetProperty("data");
                    var targetUserId = d.GetProperty("target_user_id").GetGuid();
                    var channel = await _network.OpenDmAsync(targetUserId);
                    var reqId = d.TryGetProperty("req_id", out var r) && r.ValueKind == JsonValueKind.String ? r.GetString() : null;
                    Publish("dm.opened", new
                    {
                        channel,
                        target_user_id = targetUserId.ToString(),
                        req_id = reqId,
                    });
                    break;
                }
                case "member.set_color":
                {
                    var d = root.GetProperty("data");
                    var color = d.TryGetProperty("name_color", out var c) && c.ValueKind == JsonValueKind.String
                        ? c.GetString() : null;
                    await _network.SetNameColorAsync(d.GetProperty("user_id").GetGuid(), color);
                    break;
                }
                case "profile.avatar.pick":
                {
                    var avatarPicker = new Microsoft.Win32.OpenFileDialog
                    {
                        Title = "Escolher foto de perfil",
                        Filter = "Imagens|*.png;*.jpg;*.jpeg;*.gif;*.webp",
                    };
                    if (avatarPicker.ShowDialog() == true)
                        await _network.UploadAvatarAsync(avatarPicker.FileName);
                    break;
                }
                case "hotkey.configure":
                {
                    var data = root.GetProperty("data");
                    var enabled = data.TryGetProperty("enabled", out var enabledValue) && enabledValue.GetBoolean();
                    var code = data.TryGetProperty("code", out var codeValue) ? codeValue.GetString() : null;
                    _hotkey.Configure(code, enabled);
                    break;
                }
                // Everything below is a pure relay to the authenticated
                // WebSocket — the JS RTC engine (client/ui/src/rtc.ts) owns
                // all of the actual call/screen-share semantics now.
                case "call.state.update":
                case "voice.presence.enter":
                case "voice.presence.leave":
                case "voice.track.published":
                case "voice.track.unpublished":
                case "voice.move_member":
                case "voice.disconnect_member":
                case "music.command":
                case "chat.message.create":
                case "chat.message.edit":
                case "chat.message.delete":
                case "chat.typing":
                case "presence.set":
                    await _network.SendWebSocketAsync(op!, root.GetProperty("data"));
                    break;
                case "screen.sources.list":
                {
                    var list = await Task.Run(ScreenCapture.Enumerate);
                    Publish("screen.sources", new
                    {
                        sources = list.ConvertAll(s => new { id = s.Id, kind = s.Kind, title = s.Title, thumbnail = s.Thumbnail }),
                    });
                    break;
                }
                case "screen.capture.start":
                {
                    var d = root.GetProperty("data");
                    var sourceId = d.GetProperty("source_id").GetString() ?? "screen:all";
                    var maxHeight = d.TryGetProperty("max_height", out var mh) ? mh.GetInt32() : 1080;
                    var maxFps = d.TryGetProperty("max_fps", out var mf) ? mf.GetInt32() : 30;
                    var withAudio = d.TryGetProperty("audio", out var au) && au.ValueKind == JsonValueKind.True;
                    _screen.Start(sourceId, maxHeight, maxFps, jpeg =>
                    {
                        var slot = System.Threading.Interlocked.Increment(ref _frameSeq) & 1;
                        WriteFrameSlot?.Invoke(jpeg, slot);
                        Publish("screen.frame", new { slot, len = jpeg.Length });
                    });
                    if (withAudio)
                    {
                        var (pid, mode) = ScreenCapture.ResolveAudioTarget(sourceId, BrowserProcessId);
                        _audio.Start(pid, mode, pcm =>
                        {
                            var slot = (int)((uint)System.Threading.Interlocked.Increment(ref _audioSeq) % (uint)AudioSlotCount);
                            WriteAudioSlot?.Invoke(pcm, slot);
                            Publish("screen.audio", new { slot, len = pcm.Length });
                        });
                    }
                    break;
                }
                case "screen.capture.stop":
                    _screen.Stop();
                    _audio.Stop();
                    break;
                case "activity.config":
                    _activity.SetEnabled(root.GetProperty("data").GetProperty("enabled").GetBoolean());
                    break;
                case "livekit.token.request":
                {
                    var d = root.GetProperty("data");
                    var tokenRequestId = d.GetProperty("request_id").GetString();
                    var mode = d.TryGetProperty("mode", out var modeValue) ? modeValue.GetString() ?? "participant" : "participant";
                    var roomToken = await _network.GetLiveKitTokenAsync(d.GetProperty("channel_id").GetGuid(), mode);
                    Publish("livekit.token", new
                    {
                        request_id = tokenRequestId,
                        url = roomToken.GetProperty("url").GetString(),
                        access_token = roomToken.GetProperty("token").GetString(),
                    });
                    break;
                }
                case "host.title":
                    HostTitleChanged?.Invoke(this,
                        root.GetProperty("data").TryGetProperty("text", out var titleText)
                            ? titleText.GetString() ?? "" : "");
                    break;
                case "update.check":
                {
                    var update = await _updater.CheckAsync();
                    if (update != null)
                    {
                        Publish("update.available", new
                        {
                            current_version = update.CurrentVersion,
                            latest_version = update.LatestVersion,
                            release_notes = update.ReleaseNotes,
                            download_url = update.DownloadUrl,
                            file_size_bytes = update.FileSizeBytes
                        });
                    }
                    else
                    {
                        Publish("update.not_available", new { current_version = UpdateChecker.GetCurrentVersion() });
                    }
                    break;
                }
                case "update.download":
                {
                    var downloadUrl = root.GetProperty("data").GetProperty("download_url").GetString()
                        ?? throw new InvalidOperationException("Download URL não informada.");
                    _ = Task.Run(async () =>
                    {
                        try
                        {
                            var setupPath = await _updater.DownloadUpdateAsync(downloadUrl, (percent, downloaded, total) =>
                            {
                                Publish("update.progress", new { percent, downloaded, total });
                            });
                            Publish("update.ready", new { file_path = setupPath });
                        }
                        catch (Exception ex)
                        {
                            DebugLog.Write($"Update download failed: {ex.Message}");
                            Publish("update.error", new { message = ex.Message });
                        }
                    });
                    break;
                }
                case "update.apply":
                {
                    var path = root.GetProperty("data").TryGetProperty("file_path", out var p) ? p.GetString() : null;
                    _updater.ApplyUpdate(path);
                    break;
                }
                default:
                    Publish("error", new { code = "unknown_ipc_op", op });
                    break;
            }
        }
        catch (Exception exception)
        {
            DebugLog.Write($"FAILED: {exception}");
            Publish("error", new { code = "ipc_request_failed", message = exception.Message, in_reply_to = requestId });
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
    ///
    /// The one exception: `activity.*` events may carry `asset_image:
    /// "att:<hash>"` refs. We inline those as `data:` URIs here (fetched with
    /// the session token) so the WebView never has to hit the API origin
    /// itself — no mixed-content, CORS, or auth concern. `steam:`/`https:`
    /// refs pass straight through.
    private async void HandleNetworkEvent(string op, JsonElement data)
    {
        if (op is "activity.snapshot" or "activity.update")
        {
            try
            {
                var hydrated = await HydrateActivityAssetsAsync(data);
                if (hydrated is not null) { Publish(op, hydrated); return; }
            }
            catch (Exception exception) { DebugLog.Write($"activity asset hydrate failed: {exception.Message}"); }
        }
        // A renamed member's `avatar_url` is an `/api/...` path the WebView
        // cannot authenticate against — inline it to a data: URI here, exactly
        // as bootstrap avatars are handled (NetworkClient.HydrateMediaUrlsAsync).
        if (op == "member.updated")
        {
            try
            {
                var node = JsonNode.Parse(data.GetRawText())?.AsObject();
                if (node is not null)
                {
                    if (node["avatar_url"] is JsonValue value
                        && value.TryGetValue<string>(out var url)
                        && url is not null
                        && url.StartsWith("/api/", StringComparison.Ordinal))
                    {
                        node["avatar_url"] = await _network.TryGetMediaDataUriAsync(url);
                    }
                    Publish(op, node);
                    return;
                }
            }
            catch (Exception exception) { DebugLog.Write($"member.updated hydrate failed: {exception.Message}"); }
        }
        if (op == "chat.message.created")
        {
            try
            {
                var hydrated = await _network.HydrateMediaUrlsAsync(data);
                Publish(op, hydrated);
                return;
            }
            catch (Exception exception) { DebugLog.Write($"chat.message.created media inline failed: {exception.Message}"); }
        }
        Publish(op, data);
    }

    private static string RequiredString(JsonElement root, string field)
    {
        var value = root.GetProperty("data").TryGetProperty(field, out var element) ? element.GetString() : null;
        if (string.IsNullOrWhiteSpace(value)) throw new InvalidOperationException($"Campo '{field}' é obrigatório.");
        return value.Trim();
    }

    private readonly Dictionary<string, string> _assetDataUris = new();

    private async Task<JsonNode?> HydrateActivityAssetsAsync(JsonElement data)
    {
        var root = JsonNode.Parse(data.GetRawText());
        if (root is null) return null;
        foreach (var node in EnumerateObjects(root))
        {
            if (node["asset_image"] is not JsonValue value
                || !value.TryGetValue<string>(out var reference)
                || reference is null
                || !reference.StartsWith("att:", StringComparison.Ordinal))
                continue;
            var hash = reference[4..];
            if (!_assetDataUris.TryGetValue(hash, out var dataUri))
            {
                dataUri = await _network.GetActivityAssetDataUriAsync(hash) ?? "";
                _assetDataUris[hash] = dataUri;
            }
            node["asset_image"] = dataUri.Length > 0 ? dataUri : null;
        }
        return root;
    }

    private static IEnumerable<JsonObject> EnumerateObjects(JsonNode node)
    {
        if (node is JsonObject obj)
        {
            yield return obj;
            foreach (var property in obj)
                if (property.Value is not null)
                    foreach (var child in EnumerateObjects(property.Value))
                        yield return child;
        }
        else if (node is JsonArray array)
        {
            foreach (var item in array)
                if (item is not null)
                    foreach (var child in EnumerateObjects(item))
                        yield return child;
        }
    }

    public void Publish(string op, object data)
    {
        EventReady?.Invoke(this, JsonSerializer.Serialize(new { v = 1, op, data }));
    }

    public void CheckUpdatesOnStartup()
    {
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(3500); // Give the web UI time to mount and register IPC handlers
                var update = await _updater.CheckAsync();
                if (update != null)
                {
                    Publish("update.available", new
                    {
                        current_version = update.CurrentVersion,
                        latest_version = update.LatestVersion,
                        release_notes = update.ReleaseNotes,
                        download_url = update.DownloadUrl,
                        file_size_bytes = update.FileSizeBytes
                    });
                }
            }
            catch (Exception ex) { DebugLog.Write($"Startup update check failed: {ex.Message}"); }
        });
    }

    public void Dispose() { _hotkey.Dispose(); _screen.Dispose(); _audio.Dispose(); _activity.Dispose(); }
}
