using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace Talkeando.Client;

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

    public NetworkClient(SessionStore sessions)
    {
        _sessions = sessions;
        var baseUrl = Environment.GetEnvironmentVariable("TALKEANDO_API_BASE_URL")
            ?? "http://localhost:8080/api";
        _http = new HttpClient { BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/") };
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
            channels,
        });
        return payload;
    }

    public async Task<JsonElement> HistoryAsync(Guid channelId)
    {
        using var response = await GetAsync($"channels/{channelId}/messages");
        return response.RootElement.Clone();
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

    public async Task OpenAttachmentAsync(Guid attachmentId, string filename)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, $"attachments/{attachmentId}");
        AddAuthorization(request);
        using var response = await _http.SendAsync(request);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException("Não foi possível baixar o anexo.");
        var safeName = String.Concat(filename.Select(character => Path.GetInvalidFileNameChars().Contains(character) ? '_' : character));
        var directory = Path.Combine(Path.GetTempPath(), "Talkeando", "attachments");
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
            var wsUrl = Environment.GetEnvironmentVariable("TALKEANDO_WS_URL") ?? "ws://localhost:8080/ws";
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
