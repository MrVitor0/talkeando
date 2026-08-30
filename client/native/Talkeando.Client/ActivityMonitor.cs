using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;
using Windows.Media;
using Windows.Media.Control;
using Windows.Storage.Streams;

namespace Tupi.Client;

/// SDD/specs/activity.md. Reports what the user is doing outside Tupi as
/// `activity.report` frames over the authenticated WebSocket:
///   Phase 1 — whatever is playing via the Windows System Media Transport
///             Controls (Spotify, a browser tab, VLC, …).
///   Phase 2 — the running game: Steam (authoritative `RunningAppID` +
///             `appmanifest` name, `steam:<appid>` artwork ref) plus a
///             curated list of common non-Steam titles by executable name,
///             with the `.exe` icon uploaded to the activity-asset store.
///
/// Everything is best-effort: missing SMTC, a locked-down process, or a
/// WebSocket that isn't open yet just means a quieter tick.
public sealed class ActivityMonitor : IDisposable
{
    // ACT-FR-010: at least this long between consecutive non-empty reports;
    // faster changes are coalesced. A transition to "nothing" skips it.
    private static readonly TimeSpan Debounce = TimeSpan.FromSeconds(4);
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(10);

    private readonly Func<object, Task> _send;
    private readonly Func<byte[], string, Task<string?>>? _uploadAsset;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly DiscordRpcListener _rpc;

    private GlobalSystemMediaTransportControlsSessionManager? _manager;
    private GlobalSystemMediaTransportControlsSession? _session;
    private System.Threading.Timer? _pollTimer;
    private System.Threading.Timer? _debounceTimer;

    private bool _enabled = true;
    private bool _started;
    private bool _disposed;

    private string _lastSignature = "";
    private DateTimeOffset _lastSendAt = DateTimeOffset.MinValue;

    // Anchor the elapsed timer to when the current track first appeared so
    // re-observing the same song does not reset the UI clock.
    private string _trackKey = "";
    private DateTimeOffset _trackSince = DateTimeOffset.UtcNow;

    // Per game_key: when we first saw it this session, and its resolved
    // Steam name (cached so a poll doesn't rescan/re-parse the ACF).
    private readonly Dictionary<string, DateTimeOffset> _gameSince = new();
    private readonly Dictionary<int, string> _steamNames = new();

    // Uploaded-asset cache keyed by a caller-chosen key: a resolved
    // "att:<hash>" ref, or "" once we've given up after AssetMaxAttempts.
    private const int AssetMaxAttempts = 4;
    private readonly Dictionary<string, string> _assetRefs = new();
    private readonly Dictionary<string, (int Attempts, DateTimeOffset RetryAfter)> _assetFails = new();

    public ActivityMonitor(Func<object, Task> send, Func<byte[], string, Task<string?>>? uploadAsset = null)
    {
        _send = send;
        _uploadAsset = uploadAsset;
        _rpc = new DiscordRpcListener(() => Kick());
    }

    /// ACT-FR-008: toggled by the UI via the `activity.config` IPC op. When
    /// turned off the monitor emits one empty report and never sends a
    /// non-empty one again until turned back on.
    public void SetEnabled(bool enabled)
    {
        // Process/Steam/SMTC discovery can be expensive on its first pass.
        // IPC arrives on WPF's dispatcher thread, so explicitly move the whole
        // operation to the thread pool and never stall rendering/input.
        _ = Task.Run(() => SetEnabledAsync(enabled));
    }

    private async Task SetEnabledAsync(bool enabled)
    {
        _enabled = enabled;
        if (enabled) { await EnsureStartedAsync(); _rpc.Start(); }
        else _rpc.Stop();
        await EvaluateAsync(force: true);
    }

    private async Task EnsureStartedAsync()
    {
        if (_started || _disposed) return;
        _started = true;
        // A process poll covers games even when SMTC is unavailable.
        _pollTimer = new System.Threading.Timer(_ => Kick(), null, PollInterval, PollInterval);
        try
        {
            _manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
            _manager.CurrentSessionChanged += (_, _) => { HookCurrentSession(); Kick(); };
            HookCurrentSession();
            DebugLog.Write("ActivityMonitor: SMTC session manager ready");
        }
        catch (Exception exception)
        {
            DebugLog.Write($"ActivityMonitor: SMTC unavailable ({exception.Message})");
        }
    }

    private void HookCurrentSession()
    {
        var next = _manager?.GetCurrentSession();
        if (ReferenceEquals(next, _session)) return;
        _session = next;
        if (_session is null) return;
        // Old session objects become unreferenced and are collected with
        // their handlers; no explicit unsubscribe needed at this cadence.
        _session.MediaPropertiesChanged += (_, _) => Kick();
        _session.PlaybackInfoChanged += (_, _) => Kick();
    }

    private void Kick() => _ = EvaluateAsync();

    private async Task EvaluateAsync(bool force = false)
    {
        if (_disposed) return;
        await _gate.WaitAsync();
        try
        {
            var activities = _enabled ? await BuildAsync() : Array.Empty<object>();
            var signature = JsonSerializer.Serialize(activities);
            if (!force && signature == _lastSignature) return;

            var empty = activities.Length == 0;
            var sinceLast = DateTimeOffset.UtcNow - _lastSendAt;
            if (!empty && !force && sinceLast < Debounce)
            {
                _debounceTimer?.Dispose();
                _debounceTimer = new System.Threading.Timer(
                    _ => Kick(), null, Debounce - sinceLast, Timeout.InfiniteTimeSpan);
                return;
            }

            _lastSignature = signature;
            _lastSendAt = DateTimeOffset.UtcNow;
            try { await _send(new { activities }); }
            catch (Exception exception) { DebugLog.Write($"activity.report failed: {exception.Message}"); }
        }
        catch (Exception exception)
        {
            DebugLog.Write($"ActivityMonitor.Evaluate failed: {exception.Message}");
        }
        finally { _gate.Release(); }
    }

    private async Task<object[]> BuildAsync()
    {
        var list = new List<object>();
        var media = await BuildMediaAsync();
        if (media is not null) list.Add(media);

        // A game's own Discord rich presence wins over process/Steam guessing.
        var rpc = _rpc.Current;
        var game = rpc is not null ? RpcToActivity(rpc) : await DetectGameAsync();
        if (game is not null) list.Add(game);
        else _gameSince.Clear();
        return list.ToArray();
    }

    // ---- Phase 1: SMTC media ------------------------------------------------

    private async Task<object?> BuildMediaAsync()
    {
        if (_session is null) return null;

        var playback = _session.GetPlaybackInfo();
        if (playback?.PlaybackStatus != GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing)
            return null;

        GlobalSystemMediaTransportControlsSessionMediaProperties? props = null;
        try { props = await _session.TryGetMediaPropertiesAsync(); }
        catch { /* transient — treat as nothing playing this tick */ }
        if (props is null || string.IsNullOrWhiteSpace(props.Title)) return null;

        // Browser media sessions expose the title of the active tab. They are
        // too broad for community presence (and may disclose what someone is
        // watching/listening to), so only report dedicated media apps here.
        if (IsBrowserSession(_session.SourceAppUserModelId)) return null;

        var title = props.Title.Trim();
        var artist = (props.Artist ?? "").Trim();
        if (artist.Length == 0) artist = (props.AlbumArtist ?? "").Trim();
        var album = (props.AlbumTitle ?? "").Trim();
        var appName = FriendlyAppName(_session.SourceAppUserModelId);
        var isVideo = playback.PlaybackType == MediaPlaybackType.Video;

        var trackKey = $"{appName}{title}{artist}";
        if (trackKey != _trackKey)
        {
            _trackKey = trackKey;
            _trackSince = EstimateStart(_session);
        }

        // Album/track thumbnail from SMTC → uploaded once per track, then an
        // `att:<hash>` ref (deduped server-side by content hash anyway).
        string? artRef = null;
        if (props.Thumbnail is not null)
            artRef = await AssetRefAsync($"art:{trackKey}", () => ReadThumbnailAsync(props.Thumbnail));

        return new
        {
            kind = isVideo ? "watching" : "listening",
            name = appName,
            details = title,
            state = artist.Length > 0 ? artist : null,
            started_at = Rfc3339(_trackSince),
            asset_image = artRef,
            asset_text = album.Length > 0 ? album : null,
        };
    }

    private static async Task<(byte[], string)> ReadThumbnailAsync(IRandomAccessStreamReference reference)
    {
        using var stream = await reference.OpenReadAsync();
        if (stream.Size == 0 || stream.Size > 4 * 1024 * 1024) return (Array.Empty<byte>(), "image/png");
        var buffer = new byte[stream.Size];
        var reader = new DataReader(stream);
        await reader.LoadAsync((uint)stream.Size);
        reader.ReadBytes(buffer);
        var contentType = stream.ContentType == "image/jpeg" ? "image/jpeg" : "image/png";
        return (buffer, contentType);
    }

    private static DateTimeOffset EstimateStart(GlobalSystemMediaTransportControlsSession session)
    {
        try
        {
            var timeline = session.GetTimelineProperties();
            var updated = timeline.LastUpdatedTime;
            if (updated > DateTimeOffset.UnixEpoch && timeline.Position >= TimeSpan.Zero)
            {
                var start = updated - timeline.Position;
                if (start <= DateTimeOffset.UtcNow && start > DateTimeOffset.UtcNow.AddDays(-1))
                    return start;
            }
        }
        catch { /* not all players report a timeline */ }
        return DateTimeOffset.UtcNow;
    }

    private static string FriendlyAppName(string? aumid)
    {
        if (string.IsNullOrWhiteSpace(aumid)) return "Mídia";
        var id = aumid.Trim();
        var lower = id.ToLowerInvariant();
        if (lower.Contains("spotify")) return "Spotify";
        if (lower.Contains("chrome")) return "Google Chrome";
        if (lower.Contains("msedge") || lower.Contains("microsoftedge")) return "Microsoft Edge";
        if (lower.Contains("firefox")) return "Firefox";
        if (lower.Contains("vlc")) return "VLC";
        if (lower.Contains("mpv")) return "mpv";
        if (lower.Contains("foobar")) return "foobar2000";
        if (lower.Contains("itunes") || lower.Contains("apple.music") || lower.Contains("applemusic")) return "Apple Music";
        if (lower.Contains("tidal")) return "TIDAL";
        if (lower.Contains("deezer")) return "Deezer";
        if (lower.EndsWith(".exe")) return id[..^4];
        var bang = id.IndexOf('!');
        if (bang > 0) id = id[..bang];
        var dot = id.LastIndexOf('.');
        return dot > 0 && dot < id.Length - 1 ? id[(dot + 1)..] : id;
    }

    private static bool IsBrowserSession(string? aumid)
    {
        if (string.IsNullOrWhiteSpace(aumid)) return false;
        var id = aumid.ToLowerInvariant();
        return id.Contains("chrome")
            || id.Contains("msedge")
            || id.Contains("microsoftedge")
            || id.Contains("firefox")
            || id.Contains("opera")
            || id.Contains("brave")
            || id.Contains("vivaldi")
            || id.Contains("chromium");
    }

    // ---- Phase 2: game detection -----------------------------------------

    private async Task<object?> DetectGameAsync()
    {
        // 1. Steam's running-app registry key is authoritative and gives the
        //    exact title + free header artwork off the CDN.
        try
        {
            using var steam = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam");
            var runningAppId = Convert.ToInt32(steam?.GetValue("RunningAppID") ?? 0);
            if (runningAppId > 0)
            {
                var name = ResolveSteamName(runningAppId) ?? $"Steam App {runningAppId}";
                return GameActivity($"steam:{runningAppId}", name, $"steam:{runningAppId}");
            }
        }
        catch (Exception exception) { DebugLog.Write($"ActivityMonitor: steam probe failed ({exception.Message})"); }

        // 2. Curated non-Steam titles, matched by executable name. Filter on
        //    the cheap `ProcessName` first so we only open a handle for hits.
        try
        {
            foreach (var process in Process.GetProcesses())
            {
                using (process)
                {
                    if (!KnownGameProcessNames.Contains(process.ProcessName)) continue;
                    string? path;
                    try { path = process.MainModule?.FileName; }
                    catch { continue; } // access denied / exited
                    if (string.IsNullOrEmpty(path)) continue;
                    var exe = Path.GetFileName(path).ToLowerInvariant();
                    if (!KnownGames.TryGetValue(exe, out var gameName)) continue;
                    var key = $"name:{gameName.ToLowerInvariant()}";
                    var exePath = path;
                    var iconRef = await AssetRefAsync($"icon:{key}",
                        () => Task.Run(() => ExtractExeIconPng(exePath)));
                    return GameActivity(key, gameName, iconRef);
                }
            }
        }
        catch (Exception exception) { DebugLog.Write($"ActivityMonitor: process probe failed ({exception.Message})"); }

        return null;
    }

    /// First time this game key was seen this session; also drops the timers
    /// for every other key, since only one game is active at a time.
    private DateTimeOffset GameSince(string key)
    {
        if (!_gameSince.TryGetValue(key, out var since))
        {
            since = DateTimeOffset.UtcNow;
            _gameSince[key] = since;
        }
        foreach (var stale in _gameSince.Keys.Where(existing => existing != key).ToList())
            _gameSince.Remove(stale);
        return since;
    }

    private object GameActivity(string key, string name, string? assetRef) => new
    {
        kind = "playing",
        name,
        details = (string?)null,
        state = (string?)null,
        started_at = Rfc3339(GameSince(key)),
        asset_image = assetRef,
        asset_text = (string?)null,
    };

    /// A game's own rich presence (Discord IPC) — richer than process/Steam
    /// detection: real `details`/`state` and its own start timestamp.
    private object RpcToActivity(RpcActivity rpc)
    {
        var key = $"rpc:{rpc.Name.ToLowerInvariant()}";
        var fallbackSince = GameSince(key); // also clears other games' timers
        return new
        {
            kind = "playing",
            name = rpc.Name,
            details = rpc.Details,
            state = rpc.State,
            started_at = Rfc3339(rpc.Start ?? fallbackSince),
            asset_image = (string?)null,
            asset_text = rpc.LargeText,
        };
    }

    private string? ResolveSteamName(int appId)
    {
        if (_steamNames.TryGetValue(appId, out var cached)) return cached;
        try
        {
            foreach (var library in SteamLibraryFolders())
            {
                var manifest = Path.Combine(library, "steamapps", $"appmanifest_{appId}.acf");
                if (!File.Exists(manifest)) continue;
                var match = Regex.Match(File.ReadAllText(manifest), "\"name\"\\s*\"([^\"]+)\"");
                if (match.Success)
                {
                    _steamNames[appId] = match.Groups[1].Value;
                    return match.Groups[1].Value;
                }
            }
        }
        catch (Exception exception) { DebugLog.Write($"ActivityMonitor: acf read failed ({exception.Message})"); }
        return null;
    }

    private static IEnumerable<string> SteamLibraryFolders()
    {
        string? steamPath;
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam");
            steamPath = key?.GetValue("SteamPath") as string;
        }
        catch { steamPath = null; }
        if (string.IsNullOrEmpty(steamPath)) yield break;

        yield return steamPath;
        var vdf = Path.Combine(steamPath, "steamapps", "libraryfolders.vdf");
        string text;
        try { text = File.Exists(vdf) ? File.ReadAllText(vdf) : ""; }
        catch { yield break; }
        foreach (Match match in Regex.Matches(text, "\"path\"\\s*\"([^\"]+)\""))
            yield return match.Groups[1].Value.Replace("\\\\", "\\");
    }

    /// Produce, upload once, and cache an `att:<hash>` asset ref for
    /// `cacheKey`. On failure it retries with a growing cooldown up to
    /// `AssetMaxAttempts`, then gives up (cached as "") — so a broken upload
    /// path costs one attempt every ~30-120s, not one every poll.
    private async Task<string?> AssetRefAsync(string cacheKey, Func<Task<(byte[] Bytes, string ContentType)>> produce)
    {
        if (_uploadAsset is null) return null;
        if (_assetRefs.TryGetValue(cacheKey, out var done))
            return done.Length > 0 ? done : null;
        if (_assetFails.TryGetValue(cacheKey, out var fail) && DateTimeOffset.UtcNow < fail.RetryAfter)
            return null;

        try
        {
            var (bytes, contentType) = await produce();
            if (bytes.Length > 0)
            {
                var id = await _uploadAsset(bytes, contentType);
                if (!string.IsNullOrEmpty(id))
                {
                    var reference = $"att:{id}";
                    _assetRefs[cacheKey] = reference;
                    _assetFails.Remove(cacheKey);
                    return reference;
                }
            }
        }
        catch (Exception exception)
        {
            DebugLog.Write($"ActivityMonitor: asset upload failed for {cacheKey} ({exception.Message})");
        }

        var attempts = (_assetFails.TryGetValue(cacheKey, out var prev) ? prev.Attempts : 0) + 1;
        if (attempts >= AssetMaxAttempts)
        {
            _assetRefs[cacheKey] = ""; // give up for the session
            _assetFails.Remove(cacheKey);
        }
        else
        {
            _assetFails[cacheKey] = (attempts, DateTimeOffset.UtcNow.AddSeconds(30 * attempts));
        }
        return null;
    }

    private static (byte[], string) ExtractExeIconPng(string exePath)
    {
        using var icon = Icon.ExtractAssociatedIcon(exePath);
        if (icon is null) return (Array.Empty<byte>(), "image/png");
        using var bitmap = icon.ToBitmap();
        using var stream = new MemoryStream();
        bitmap.Save(stream, ImageFormat.Png);
        return (stream.ToArray(), "image/png");
    }

    private static string Rfc3339(DateTimeOffset value) =>
        value.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ");

    // Non-Steam titles worth recognising by executable name (Steam games are
    // resolved dynamically above). Keys are lowercase `.exe` file names.
    private static readonly Dictionary<string, string> KnownGames = new(StringComparer.OrdinalIgnoreCase)
    {
        ["leagueoflegends.exe"] = "League of Legends",
        ["league of legends.exe"] = "League of Legends",
        ["valorant.exe"] = "VALORANT",
        ["valorant-win64-shipping.exe"] = "VALORANT",
        ["fortniteclient-win64-shipping.exe"] = "Fortnite",
        ["r5apex.exe"] = "Apex Legends",
        ["r5apex_dx12.exe"] = "Apex Legends",
        ["gta5.exe"] = "Grand Theft Auto V",
        ["gtav.exe"] = "Grand Theft Auto V",
        ["rocketleague.exe"] = "Rocket League",
        ["cs2.exe"] = "Counter-Strike 2",
        ["dota2.exe"] = "Dota 2",
        ["overwatch.exe"] = "Overwatch 2",
        ["bg3.exe"] = "Baldur's Gate 3",
        ["bg3_dx11.exe"] = "Baldur's Gate 3",
        ["eldenring.exe"] = "ELDEN RING",
        ["factorio.exe"] = "Factorio",
        ["stardewvalley.exe"] = "Stardew Valley",
        ["stardew valley.exe"] = "Stardew Valley",
        ["hades.exe"] = "Hades",
        ["hades2.exe"] = "Hades II",
        ["terraria.exe"] = "Terraria",
        ["amongus.exe"] = "Among Us",
        ["among us.exe"] = "Among Us",
        ["phasmophobia.exe"] = "Phasmophobia",
        ["deadbydaylight-win64-shipping.exe"] = "Dead by Daylight",
        ["palworld-win64-shipping.exe"] = "Palworld",
        ["helldivers2.exe"] = "HELLDIVERS 2",
        ["cyberpunk2077.exe"] = "Cyberpunk 2077",
        ["witcher3.exe"] = "The Witcher 3",
        ["minecraftlauncher.exe"] = "Minecraft",
        ["wow.exe"] = "World of Warcraft",
        ["wowclassic.exe"] = "World of Warcraft",
        ["roblox.exe"] = "Roblox",
        ["robloxplayerbeta.exe"] = "Roblox",
    };

    private static readonly HashSet<string> KnownGameProcessNames = KnownGames.Keys
        .Select(name => name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? name[..^4] : name)
        .ToHashSet(StringComparer.OrdinalIgnoreCase);

    public void Dispose()
    {
        _disposed = true;
        _rpc.Dispose();
        _pollTimer?.Dispose();
        _debounceTimer?.Dispose();
        _gate.Dispose();
    }
}
