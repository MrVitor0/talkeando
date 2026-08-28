using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Tupi.Client;

/// Formerly declared alongside the native RtcEngine (deleted — WebRTC now
/// runs in client/ui/src/rtc.ts, see SDD/27-decisions.md ADR-009); kept here
/// since NetworkClient is the only remaining consumer (rtc.turn_credentials
/// is relayed to the UI via IpcBridge, itself just JSON, not this record).
public sealed record TurnCredentials(string Username, string Credential, IReadOnlyList<string> Uris);

/// HTTP boundary owned by the native host. The WebView asks for product
/// actions, but never receives or persists the bearer token.
public sealed class NetworkClient
{
    private readonly SessionStore _sessions;
    private readonly HttpClient _http;
    private readonly SemaphoreSlim _webSocketGate = new(1, 1);
    private ClientWebSocket? _webSocket;
    private Action<string, JsonElement>? _onWebSocketEvent;
    private int _reconnectAttempt;

    /// API root without a trailing slash (e.g. `http://localhost:8080/api`).
    /// Handed to the UI in the bootstrap payload so it can build `<img>` URLs
    /// for the unauthenticated activity-asset endpoint (SDD/specs/activity.md).
    public string ApiBaseUrl { get; }

    public NetworkClient(SessionStore sessions)
    {
        _sessions = sessions;
        var baseUrl = Environment.GetEnvironmentVariable("TUPI_API_BASE_URL")
            ?? ReadEndpointSetting("apiBaseUrl")
            ?? "http://localhost:8080/api";
        ApiBaseUrl = baseUrl.TrimEnd('/');
        _http = new HttpClient { BaseAddress = new Uri(ApiBaseUrl + "/") };
    }

    /// Content-addressed upload of a game icon (PNG). Returns the server's
    /// hash id; the same bytes always map to the same id, so callers cache it.
    public async Task<string?> UploadActivityAssetAsync(byte[] bytes, string contentType = "image/png")
    {
        using var form = new MultipartFormDataContent();
        using var content = new ByteArrayContent(bytes);
        content.Headers.ContentType = new MediaTypeHeaderValue(contentType == "image/jpeg" ? "image/jpeg" : "image/png");
        form.Add(content, "file", contentType == "image/jpeg" ? "art.jpg" : "art.png");
        using var request = new HttpRequestMessage(HttpMethod.Post, "activity-assets") { Content = form };
        AddAuthorization(request);
        using var response = await _http.SendAsync(request);
        if (!response.IsSuccessStatusCode) return null;
        using var result = await ReadJsonAsync(response);
        return result.RootElement.TryGetProperty("id", out var id) ? id.GetString() : null;
    }

    /// Fetch an activity asset by hash and inline it as a `data:` URI so the
    /// WebView renders it without any cross-origin / mixed-content / auth
    /// concern (same approach as `HydrateMediaUrlsAsync` for REST payloads).
    public async Task<string?> GetActivityAssetDataUriAsync(string hash)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, $"activity-assets/{hash}");
        AddAuthorization(request);
        using var response = await _http.SendAsync(request);
        if (!response.IsSuccessStatusCode) return null;
        var bytes = await response.Content.ReadAsByteArrayAsync();
        if (bytes.Length == 0 || bytes.Length > 1024 * 1024) return null;
        var type = response.Content.Headers.ContentType?.MediaType ?? "image/png";
        return $"data:{type};base64,{Convert.ToBase64String(bytes)}";
    }

    /// Production installers ship this non-secret file beside the executable.
    /// Environment variables still take precedence, which preserves the local
    /// development workflow without asking beta users to configure anything.
    private static string? ReadEndpointSetting(string name)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "tupi.settings.json");
        if (!File.Exists(path)) return null;
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(path));
            return document.RootElement.TryGetProperty(name, out var value)
                ? value.GetString()
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public async Task<JsonElement> LoginAsync(JsonElement data) => await AuthenticateAsync("auth/login", data);
    public async Task<JsonElement> RegisterAsync(JsonElement data) => await AuthenticateAsync("auth/register", data);

    public async Task<JsonElement> BootstrapAsync()
    {
        using var me = await GetAsync("auth/me");
        using var community = await GetAsync("community");
        using var channelData = await GetAsync("channels");
        var channels = new List<JsonElement>();
        if (channelData.RootElement.TryGetProperty("categories", out var categories))
            foreach (var category in categories.EnumerateArray())
                if (category.TryGetProperty("channels", out var categoryChannels))
                    channels.AddRange(categoryChannels.EnumerateArray().Select(channel => channel.Clone()));
        if (channelData.RootElement.TryGetProperty("uncategorized_channels", out var uncategorized))
            channels.AddRange(uncategorized.EnumerateArray().Select(channel => channel.Clone()));
        var payload = JsonSerializer.SerializeToElement(new {
            currentUser = me.RootElement.GetProperty("user").Clone(),
            community = community.RootElement.Clone(),
            members = community.RootElement.GetProperty("members").Clone(),
            categories = channelData.RootElement.TryGetProperty("categories", out var categoryData)
                ? categoryData.Clone()
                : JsonSerializer.SerializeToElement(Array.Empty<object>()),
            channels,
            apiBaseUrl = ApiBaseUrl,
        });
        return await HydrateMediaUrlsAsync(payload);
    }

    public async Task<JsonElement> HistoryAsync(Guid channelId)
    {
        using var response = await GetAsync($"channels/{channelId}/messages");
        return await HydrateMediaUrlsAsync(response.RootElement.Clone());
    }

    public async Task<TurnCredentials> GetTurnCredentialsAsync()
    {
        using var response = await GetAsync("turn-credentials");
        var root = response.RootElement;
        var credential = root.TryGetProperty("credential", out var standardCredential)
            ? standardCredential.GetString()
            : root.GetProperty("password").GetString();
        return new TurnCredentials(
            root.GetProperty("username").GetString() ?? throw new InvalidOperationException("TURN sem username."),
            credential ?? throw new InvalidOperationException("TURN sem credencial."),
            root.GetProperty("uris").EnumerateArray().Select(uri => uri.GetString() ?? String.Empty).Where(uri => uri.Length > 0).ToArray()
        );
    }

    public async Task<JsonElement> UploadAttachmentAsync(Guid channelId, string filePath)
    {
        if (!File.Exists(filePath)) throw new FileNotFoundException("Arquivo não encontrado.", filePath);
        using var form = new MultipartFormDataContent();
        await using var file = File.OpenRead(filePath);
        using var content = new StreamContent(file);
        content.Headers.ContentType = new MediaTypeHeaderValue(GuessContentType(filePath));
        form.Add(content, "file", Path.GetFileName(filePath));
        using var request = new HttpRequestMessage(HttpMethod.Post, $"channels/{channelId}/attachments") { Content = form };
        AddAuthorization(request);
        using var response = await _http.SendAsync(request);
        using var result = await ReadJsonAsync(response);
        return result.RootElement.Clone();
    }

    /// PROFILE-FR: rename yourself. The server fans a `member.updated` event
    /// back over the WebSocket, so there is nothing to return here.
    public async Task UpdateDisplayNameAsync(string displayName)
    {
        using var request = new HttpRequestMessage(HttpMethod.Patch, "me")
        {
            Content = new StringContent(
                JsonSerializer.Serialize(new { display_name = displayName }), Encoding.UTF8, "application/json"),
        };
        AddAuthorization(request);
        using var response = await _http.SendAsync(request);
        using var _ = await ReadJsonAsync(response);
    }

    /// PROFILE-FR: rename another member (any member may, v1's "small circle"
    /// scoping). Broadcast handled server-side.
    public async Task RenameMemberAsync(Guid userId, string displayName)
    {
        using var request = new HttpRequestMessage(HttpMethod.Patch, $"users/{userId}")
        {
            Content = new StringContent(
                JsonSerializer.Serialize(new { display_name = displayName }), Encoding.UTF8, "application/json"),
        };
        AddAuthorization(request);
        using var response = await _http.SendAsync(request);
        using var _ = await ReadJsonAsync(response);
    }

    /// CHAN-FR (rename): change just a channel's name. Server broadcasts
    /// `channel.updated`.
    public async Task RenameChannelAsync(Guid channelId, string name)
    {
        using var request = new HttpRequestMessage(HttpMethod.Patch, $"channels/{channelId}/name")
        {
            Content = new StringContent(
                JsonSerializer.Serialize(new { name }), Encoding.UTF8, "application/json"),
        };
        AddAuthorization(request);
        using var response = await _http.SendAsync(request);
        using var _ = await ReadJsonAsync(response);
    }

    /// PROFILE-FR: replace your own avatar with a local image file.
    public async Task UploadAvatarAsync(string filePath)
    {
        if (!File.Exists(filePath)) throw new FileNotFoundException("Arquivo não encontrado.", filePath);
        using var form = new MultipartFormDataContent();
        await using var file = File.OpenRead(filePath);
        using var content = new StreamContent(file);
        content.Headers.ContentType = new MediaTypeHeaderValue(GuessContentType(filePath));
        form.Add(content, "file", Path.GetFileName(filePath));
        using var request = new HttpRequestMessage(HttpMethod.Post, "me/avatar") { Content = form };
        AddAuthorization(request);
        using var response = await _http.SendAsync(request);
        using var _ = await ReadJsonAsync(response);
    }

    /// Best-effort variant of the private media inliner, for WebSocket events
    /// (e.g. `member.updated`) whose avatar URL the WebView cannot fetch
    /// itself. Returns null instead of throwing so a missing image never
    /// drops the whole event.
    public async Task<string?> TryGetMediaDataUriAsync(string path)
    {
        try { return await GetMediaDataUriAsync(path); }
        catch { return null; }
    }

    public async Task OpenAttachmentAsync(Guid attachmentId, string filename)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, $"attachments/{attachmentId}");
        AddAuthorization(request);
        using var response = await _http.SendAsync(request);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException("Não foi possível baixar o anexo.");
        var safeName = String.Concat(filename.Select(character => Path.GetInvalidFileNameChars().Contains(character) ? '_' : character));
        var directory = Path.Combine(Path.GetTempPath(), "Tupi", "attachments");
        Directory.CreateDirectory(directory);
        var target = Path.Combine(directory, $"{attachmentId}-{safeName}");
        await File.WriteAllBytesAsync(target, await response.Content.ReadAsByteArrayAsync());
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(target) { UseShellExecute = true });
    }

    public async Task ConnectWebSocketAsync(Action<string, JsonElement> onEvent)
    {
        _onWebSocketEvent = onEvent;
        if (_webSocket?.State == WebSocketState.Open) return;
        await _webSocketGate.WaitAsync();
        try
        {
            if (_webSocket?.State == WebSocketState.Open) return;
            _webSocket?.Dispose();
            _webSocket = new ClientWebSocket();
            var wsUrl = Environment.GetEnvironmentVariable("TUPI_WS_URL")
                ?? ReadEndpointSetting("webSocketUrl")
                ?? "ws://localhost:8080/ws";
            await _webSocket.ConnectAsync(new Uri(wsUrl), CancellationToken.None);
            var token = _sessions.Load() ?? throw new InvalidOperationException("Sessão não encontrada.");
            await SendWebSocketAsync("auth.hello", JsonSerializer.SerializeToElement(new { token }));
            _reconnectAttempt = 0;
            _onWebSocketEvent?.Invoke("connection.state", JsonSerializer.SerializeToElement(new { state = "connected" }));
            _ = ReceiveWebSocketAsync(_webSocket);
        }
        finally { _webSocketGate.Release(); }
    }

    public async Task SendWebSocketAsync(string op, JsonElement data)
    {
        if (_webSocket?.State != WebSocketState.Open) throw new InvalidOperationException("Conexão em tempo real indisponível.");
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { v = 1, op, data }));
        await _webSocket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
    }

    private async Task ReceiveWebSocketAsync(ClientWebSocket socket)
    {
        var buffer = new byte[64 * 1024];
        try
        {
            while (socket.State == WebSocketState.Open)
            {
                using var output = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
                    if (result.MessageType == WebSocketMessageType.Close)
                        throw new WebSocketException("O servidor encerrou a conexão em tempo real.");
                    output.Write(buffer, 0, result.Count);
                } while (!result.EndOfMessage);
                using var document = JsonDocument.Parse(output.ToArray());
                var root = document.RootElement;
                _onWebSocketEvent?.Invoke(root.GetProperty("op").GetString() ?? "error", root.GetProperty("data").Clone());
            }
        }
        catch (Exception exception)
        {
            _onWebSocketEvent?.Invoke("connection.state", JsonSerializer.SerializeToElement(new { state = "reconnecting" }));
            _ = ReconnectWebSocketAsync(exception.Message);
        }
    }

    private async Task ReconnectWebSocketAsync(string lastError)
    {
        // Bounded exponential backoff with a little jitter keeps a short
        // server outage from making every installed client reconnect at once.
        while (_sessions.HasToken)
        {
            var attempt = Interlocked.Increment(ref _reconnectAttempt);
            var delaySeconds = Math.Min(30, Math.Pow(2, Math.Min(attempt, 5))) + Random.Shared.NextDouble();
            await Task.Delay(TimeSpan.FromSeconds(delaySeconds));
            try
            {
                await ConnectWebSocketAsync(_onWebSocketEvent ?? ((_, _) => { }));
                return;
            }
            catch
            {
                _onWebSocketEvent?.Invoke("connection.state", JsonSerializer.SerializeToElement(new {
                    state = "reconnecting", message = $"Reconectando ao servidor ({lastError})"
                }));
            }
        }
        _onWebSocketEvent?.Invoke("connection.state", JsonSerializer.SerializeToElement(new { state = "disconnected" }));
    }

    private async Task<JsonElement> AuthenticateAsync(string path, JsonElement data)
    {
        using var response = await PostAsync(path, data, includeAuth: false);
        var token = response.RootElement.GetProperty("token").GetString();
        if (String.IsNullOrWhiteSpace(token)) throw new InvalidOperationException("O servidor não retornou uma sessão válida.");
        _sessions.Save(token);
        return response.RootElement.Clone();
    }

    private async Task<JsonDocument> GetAsync(string path)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        AddAuthorization(request);
        using var response = await _http.SendAsync(request);
        return await ReadJsonAsync(response);
    }

    // The WebView never receives the session token, so ordinary <img> tags
    // cannot authenticate against the API. Convert the few private avatars
    // and preview thumbnails returned in bootstrap/history into data URLs at
    // the native boundary instead.
    private async Task<JsonElement> HydrateMediaUrlsAsync(JsonElement payload)
    {
        var root = JsonNode.Parse(payload.GetRawText());
        if (root is null) return payload;
        var urls = new HashSet<string>(StringComparer.Ordinal);
        CollectMediaUrls(root, urls);
        var replacements = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var url in urls)
        {
            try { replacements[url] = await GetMediaDataUriAsync(url); }
            catch { /* a missing thumbnail must not make chat history fail */ }
        }
        ReplaceMediaUrls(root, replacements);
        return JsonSerializer.SerializeToElement(root);
    }

    private static void CollectMediaUrls(JsonNode node, ISet<string> urls)
    {
        if (node is JsonObject obj)
        {
            foreach (var property in obj)
            {
                if ((property.Key == "avatar_url" || property.Key == "image_url" || property.Key == "profile_badge_url") && property.Value is JsonValue value && value.TryGetValue<string>(out var url) && url.StartsWith("/api/", StringComparison.Ordinal)) urls.Add(url);
                if (property.Value is not null) CollectMediaUrls(property.Value, urls);
            }
            // An image attachment: { url: "/api/attachments/..", content_type: "image/..", .. }.
            // Inline it too so the chat can render a thumbnail without the token.
            if (obj["url"] is JsonValue urlValue && urlValue.TryGetValue<string>(out var attachmentUrl)
                && attachmentUrl.StartsWith("/api/", StringComparison.Ordinal)
                && obj["content_type"] is JsonValue typeValue && typeValue.TryGetValue<string>(out var contentType)
                && contentType.StartsWith("image/", StringComparison.Ordinal))
            {
                urls.Add(attachmentUrl);
            }
        }
        else if (node is JsonArray array) foreach (var item in array) if (item is not null) CollectMediaUrls(item, urls);
    }

    private static void ReplaceMediaUrls(JsonNode node, IReadOnlyDictionary<string, string> replacements)
    {
        if (node is JsonObject obj)
        {
            foreach (var property in obj.ToList())
            {
                if (property.Value is JsonValue value && value.TryGetValue<string>(out var url) && replacements.TryGetValue(url, out var dataUri)) obj[property.Key] = dataUri;
                else if (property.Value is not null) ReplaceMediaUrls(property.Value, replacements);
            }
        }
        else if (node is JsonArray array) foreach (var item in array) if (item is not null) ReplaceMediaUrls(item, replacements);
    }

    private async Task<string> GetMediaDataUriAsync(string path)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(_http.BaseAddress!, path));
        AddAuthorization(request);
        using var response = await _http.SendAsync(request);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException("Mídia privada indisponível.");
        var bytes = await response.Content.ReadAsByteArrayAsync();
        if (bytes.Length == 0 || bytes.Length > 8 * 1024 * 1024) throw new InvalidOperationException("Mídia grande demais para visualização.");
        var type = response.Content.Headers.ContentType?.MediaType ?? "application/octet-stream";
        return $"data:{type};base64,{Convert.ToBase64String(bytes)}";
    }

    private async Task<JsonDocument> PostAsync(string path, JsonElement data, bool includeAuth)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, path) {
            Content = new StringContent(data.GetRawText(), Encoding.UTF8, "application/json"),
        };
        if (includeAuth) AddAuthorization(request);
        using var response = await _http.SendAsync(request);
        return await ReadJsonAsync(response);
    }

    private void AddAuthorization(HttpRequestMessage request)
    {
        var token = _sessions.Load() ?? throw new InvalidOperationException("Sessão não encontrada.");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
    }

    private static async Task<JsonDocument> ReadJsonAsync(HttpResponseMessage response)
    {
        var body = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode)
        {
            var message = "Não foi possível falar com o servidor.";
            try { message = JsonDocument.Parse(body).RootElement.GetProperty("message").GetString() ?? message; } catch { }
            throw new InvalidOperationException(message);
        }
        return JsonDocument.Parse(body);
    }

    private static string GuessContentType(string filePath) => Path.GetExtension(filePath).ToLowerInvariant() switch
    {
        ".png" => "image/png", ".jpg" or ".jpeg" => "image/jpeg", ".gif" => "image/gif",
        ".webp" => "image/webp", ".mp4" => "video/mp4", ".mp3" => "audio/mpeg",
        ".ogg" => "audio/ogg", ".wav" => "audio/wav", ".pdf" => "application/pdf",
        ".txt" => "text/plain", ".zip" => "application/zip", _ => "application/octet-stream",
    };
}
