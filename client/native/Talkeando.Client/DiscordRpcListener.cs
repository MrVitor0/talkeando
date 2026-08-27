using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace Talkeando.Client;

/// A game's rich presence, as received over the Discord IPC pipe.
public sealed record RpcActivity(
    string Name,
    string? Details,
    string? State,
    DateTimeOffset? Start,
    string? LargeText);

/// Phase 4 of SDD/specs/activity.md. When the real Discord client is not
/// running, we impersonate it on `\\.\pipe\discord-ipc-0`: games built with
/// discord-rpc / the Discord Game SDK connect and push `SET_ACTIVITY`
/// frames, which we translate into a "playing" activity. The pipe is
/// released the moment a real Discord process appears (ACT-FR-042) — we
/// never fight it for the socket.
public sealed class DiscordRpcListener : IDisposable
{
    private static readonly string[] DiscordProcessNames =
        { "Discord", "DiscordPTB", "DiscordCanary", "DiscordDevelopment" };

    private static readonly HttpClient Http = CreateHttpClient();

    private readonly Action _onChanged;
    private readonly ConcurrentDictionary<Guid, (long Seq, RpcActivity Activity)> _byConnection = new();
    private readonly ConcurrentDictionary<string, string> _appNames = new();
    private long _seq;

    private CancellationTokenSource? _cts;
    private System.Threading.Timer? _discordWatch;
    private volatile bool _yieldedToDiscord;

    public DiscordRpcListener(Action onChanged) => _onChanged = onChanged;

    /// The freshest activity across all connected games, or null.
    public RpcActivity? Current
    {
        get
        {
            RpcActivity? best = null;
            long bestSeq = long.MinValue;
            foreach (var entry in _byConnection.Values)
                if (entry.Seq > bestSeq) { bestSeq = entry.Seq; best = entry.Activity; }
            return best;
        }
    }

    public void Start()
    {
        if (_cts is not null || _yieldedToDiscord) return;
        if (DiscordIsRunning())
        {
            DebugLog.Write("DiscordRpcListener: real Discord is running — not squatting the pipe");
            _yieldedToDiscord = true;
            return;
        }
        _cts = new CancellationTokenSource();
        _ = AcceptLoopAsync(_cts.Token);
        _discordWatch = new System.Threading.Timer(_ =>
        {
            if (DiscordIsRunning())
            {
                DebugLog.Write("DiscordRpcListener: Discord appeared — releasing the pipe");
                _yieldedToDiscord = true;
                Stop();
            }
        }, null, TimeSpan.FromSeconds(15), TimeSpan.FromSeconds(15));
        DebugLog.Write("DiscordRpcListener: listening on discord-ipc-0");
    }

    public void Stop()
    {
        _discordWatch?.Dispose();
        _discordWatch = null;
        _cts?.Cancel();
        _cts?.Dispose();
        _cts = null;
        if (!_byConnection.IsEmpty)
        {
            _byConnection.Clear();
            _onChanged();
        }
    }

    private async Task AcceptLoopAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            NamedPipeServerStream server;
            try
            {
                server = new NamedPipeServerStream(
                    "discord-ipc-0", PipeDirection.InOut, 4,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
            }
            catch (IOException)
            {
                // Every instance is busy (or the name is taken) — back off.
                try { await Task.Delay(2000, token); } catch { }
                continue;
            }
            catch (Exception exception)
            {
                DebugLog.Write($"DiscordRpcListener: pipe create failed ({exception.Message})");
                return;
            }

            try
            {
                await server.WaitForConnectionAsync(token);
            }
            catch
            {
                await server.DisposeAsync();
                return;
            }
            _ = HandleConnectionAsync(server, token);
        }
    }

    private async Task HandleConnectionAsync(NamedPipeServerStream pipe, CancellationToken token)
    {
        var id = Guid.NewGuid();
        var clientId = "";
        var header = new byte[8];
        try
        {
            while (!token.IsCancellationRequested)
            {
                if (!await ReadExactAsync(pipe, header, 8, token)) break;
                var opcode = BinaryPrimitives.ReadInt32LittleEndian(header);
                var length = BinaryPrimitives.ReadInt32LittleEndian(header.AsSpan(4));
                if (length is < 0 or > 64 * 1024) break;
                var payload = new byte[length];
                if (length > 0 && !await ReadExactAsync(pipe, payload, length, token)) break;
                var json = Encoding.UTF8.GetString(payload);

                switch (opcode)
                {
                    case 0: // HANDSHAKE
                        clientId = TryReadString(json, "client_id") ?? "";
                        if (clientId.Length > 0) _ = ResolveAppNameAsync(clientId);
                        await WriteFrameAsync(pipe, 1, ReadyFrame, token);
                        break;
                    case 1: // FRAME
                        await HandleFrameAsync(pipe, id, clientId, json, token);
                        break;
                    case 2: // CLOSE
                        return;
                    case 3: // PING -> PONG
                        await WriteFrameAsync(pipe, 4, json, token);
                        break;
                }
            }
        }
        catch (Exception exception)
        {
            DebugLog.Write($"DiscordRpcListener: connection ended ({exception.Message})");
        }
        finally
        {
            await pipe.DisposeAsync();
            if (_byConnection.TryRemove(id, out _)) _onChanged();
        }
    }

    private async Task HandleFrameAsync(
        NamedPipeServerStream pipe, Guid connectionId, string clientId, string json, CancellationToken token)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        var cmd = root.TryGetProperty("cmd", out var cmdValue) ? cmdValue.GetString() : null;
        var nonce = root.TryGetProperty("nonce", out var nonceValue) ? nonceValue.GetString() : null;

        if (cmd == "SET_ACTIVITY")
        {
            var hasActivity = root.TryGetProperty("args", out var args)
                && args.TryGetProperty("activity", out var activity)
                && activity.ValueKind == JsonValueKind.Object;
            if (hasActivity)
            {
                var parsed = ParseActivity(clientId, root.GetProperty("args").GetProperty("activity"));
                _byConnection[connectionId] = (Interlocked.Increment(ref _seq), parsed);
            }
            else
            {
                _byConnection.TryRemove(connectionId, out _);
            }
            await WriteFrameAsync(pipe, 1,
                JsonSerializer.Serialize(new { cmd, data = (object?)null, evt = (object?)null, nonce }), token);
            _onChanged();
            return;
        }

        // SUBSCRIBE / UNSUBSCRIBE / anything else: acknowledge so the game's
        // RPC client does not treat us as broken.
        await WriteFrameAsync(pipe, 1,
            JsonSerializer.Serialize(new { cmd, data = (object?)null, evt = (object?)null, nonce }), token);
    }

    private RpcActivity ParseActivity(string clientId, JsonElement activity)
    {
        var name = _appNames.TryGetValue(clientId, out var resolved) && resolved.Length > 0 ? resolved : "Jogo";
        string? details = activity.TryGetProperty("details", out var d) ? d.GetString() : null;
        string? state = activity.TryGetProperty("state", out var s) ? s.GetString() : null;
        string? largeText = null;
        if (activity.TryGetProperty("assets", out var assets) && assets.ValueKind == JsonValueKind.Object)
            largeText = assets.TryGetProperty("large_text", out var lt) ? lt.GetString() : null;

        DateTimeOffset? start = null;
        if (activity.TryGetProperty("timestamps", out var ts) && ts.ValueKind == JsonValueKind.Object
            && ts.TryGetProperty("start", out var startValue) && startValue.TryGetInt64(out var raw) && raw > 0)
        {
            // The game SDK sends milliseconds; older rich presence sent seconds.
            start = raw > 1_000_000_000_000
                ? DateTimeOffset.FromUnixTimeMilliseconds(raw)
                : DateTimeOffset.FromUnixTimeSeconds(raw);
        }
        return new RpcActivity(name, Trim(details), Trim(state), start, Trim(largeText));
    }

    private async Task ResolveAppNameAsync(string clientId)
    {
        if (_appNames.ContainsKey(clientId)) return;
        try
        {
            using var response = await Http.GetAsync($"https://discord.com/api/v10/applications/{clientId}/rpc");
            if (!response.IsSuccessStatusCode) { _appNames.TryAdd(clientId, ""); return; }
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            var name = document.RootElement.TryGetProperty("name", out var nameValue) ? nameValue.GetString() : null;
            _appNames[clientId] = name ?? "";
            if (!string.IsNullOrEmpty(name)) _onChanged();
        }
        catch (Exception exception)
        {
            DebugLog.Write($"DiscordRpcListener: app name lookup failed ({exception.Message})");
            _appNames.TryAdd(clientId, "");
        }
    }

    private static bool DiscordIsRunning()
    {
        foreach (var name in DiscordProcessNames)
        {
            try
            {
                var found = Process.GetProcessesByName(name);
                foreach (var process in found) process.Dispose();
                if (found.Length > 0) return true;
            }
            catch { /* ignore */ }
        }
        return false;
    }

    private static async Task<bool> ReadExactAsync(Stream stream, byte[] buffer, int count, CancellationToken token)
    {
        var read = 0;
        while (read < count)
        {
            var n = await stream.ReadAsync(buffer.AsMemory(read, count - read), token);
            if (n == 0) return false;
            read += n;
        }
        return true;
    }

    private static async Task WriteFrameAsync(Stream stream, int opcode, string json, CancellationToken token)
    {
        var payload = Encoding.UTF8.GetBytes(json);
        var header = new byte[8];
        BinaryPrimitives.WriteInt32LittleEndian(header, opcode);
        BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(4), payload.Length);
        await stream.WriteAsync(header, token);
        await stream.WriteAsync(payload, token);
        await stream.FlushAsync(token);
    }

    private static string? TryReadString(string json, string property)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            return document.RootElement.TryGetProperty(property, out var value) ? value.GetString() : null;
        }
        catch { return null; }
    }

    private static string? Trim(string? value)
    {
        var trimmed = value?.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : trimmed;
    }

    private const string ReadyFrame =
        "{\"cmd\":\"DISPATCH\",\"evt\":\"READY\",\"data\":{\"v\":1," +
        "\"config\":{\"cdn_host\":\"cdn.discordapp.com\",\"api_endpoint\":\"//discord.com/api\",\"environment\":\"production\"}," +
        "\"user\":{\"id\":\"0\",\"username\":\"talkeando\",\"discriminator\":\"0000\",\"avatar\":null}}}";

    private static HttpClient CreateHttpClient()
    {
        var client = new HttpClient { Timeout = TimeSpan.FromSeconds(6) };
        // The Discord API rejects requests without a User-Agent.
        client.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("Talkeando", "1.0"));
        return client;
    }

    public void Dispose() => Stop();
}
