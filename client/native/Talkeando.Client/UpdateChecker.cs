using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Reflection;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Tupi.Client;

public sealed record UpdateInfo(
    string CurrentVersion,
    string LatestVersion,
    string ReleaseNotes,
    string DownloadUrl,
    long FileSizeBytes
);

public sealed class UpdateChecker
{
    private readonly HttpClient _http = new();
    private readonly string _repo;
    private string? _downloadedSetupPath;

    public UpdateChecker(string repo = "MrVitor0/talkeando")
    {
        _repo = string.IsNullOrWhiteSpace(repo) ? "MrVitor0/talkeando" : repo;
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("TupiApp", "1.0"));
    }

    public static string GetCurrentVersion()
    {
        var ver = Assembly.GetExecutingAssembly().GetName().Version;
        return ver != null ? $"{ver.Major}.{ver.Minor}.{ver.Build}" : "0.1.0";
    }

    public async Task<UpdateInfo?> CheckAsync()
    {
        try
        {
            var url = $"https://api.github.com/repos/{_repo}/releases/latest";
            using var response = await _http.GetAsync(url);
            if (!response.IsSuccessStatusCode)
            {
                DebugLog.Write($"Update check returned status: {response.StatusCode}");
                return null;
            }

            var json = await response.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            var tagName = root.GetProperty("tag_name").GetString() ?? "";
            var releaseVersion = CleanVersionString(tagName);
            var currentVersion = GetCurrentVersion();

            if (!IsNewerVersion(releaseVersion, currentVersion))
            {
                DebugLog.Write($"Update check: current version ({currentVersion}) is up to date with latest ({tagName})");
                return null;
            }

            var body = root.TryGetProperty("body", out var b) ? b.GetString() ?? "" : "";

            string downloadUrl = "";
            long size = 0;
            if (root.TryGetProperty("assets", out var assets) && assets.ValueKind == JsonValueKind.Array)
            {
                foreach (var asset in assets.EnumerateArray())
                {
                    var name = asset.GetProperty("name").GetString() ?? "";
                    if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                    {
                        downloadUrl = asset.GetProperty("browser_download_url").GetString() ?? "";
                        size = asset.TryGetProperty("size", out var s) ? s.GetInt64() : 0;
                        break;
                    }
                }
            }

            if (string.IsNullOrEmpty(downloadUrl))
            {
                DebugLog.Write("Update check: no .exe installer asset found in latest release.");
                return null;
            }

            DebugLog.Write($"Update check: new version available! {tagName} ({size} bytes)");
            return new UpdateInfo(currentVersion, tagName, body, downloadUrl, size);
        }
        catch (Exception ex)
        {
            DebugLog.Write($"Update check failed: {ex.Message}");
            return null;
        }
    }

    public async Task<string> DownloadUpdateAsync(string downloadUrl, Action<int, long, long> onProgress, CancellationToken ct = default)
    {
        var tempFile = Path.Combine(Path.GetTempPath(), $"Tupi-Update-{Guid.NewGuid():N}.exe");
        using var response = await _http.GetAsync(downloadUrl, HttpCompletionOption.ResponseHeadersRead, ct);
        response.EnsureSuccessStatusCode();

        var totalBytes = response.Content.Headers.ContentLength ?? -1L;
        using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var fileStream = new FileStream(tempFile, FileMode.Create, FileAccess.Write, FileShare.None);

        var buffer = new byte[81920];
        long totalRead = 0;
        int bytesRead;

        while ((bytesRead = await stream.ReadAsync(buffer, 0, buffer.Length, ct)) > 0)
        {
            await fileStream.WriteAsync(buffer, 0, bytesRead, ct);
            totalRead += bytesRead;
            var percent = totalBytes > 0 ? (int)((totalRead * 100) / totalBytes) : -1;
            onProgress(percent, totalRead, totalBytes);
        }

        _downloadedSetupPath = tempFile;
        DebugLog.Write($"Update download complete: {tempFile} ({totalRead} bytes)");
        return tempFile;
    }

    public void ApplyUpdate(string? setupPath = null)
    {
        var path = setupPath ?? _downloadedSetupPath;
        if (string.IsNullOrEmpty(path) || !File.Exists(path))
            throw new FileNotFoundException("Arquivo de instalação não encontrado.");

        DebugLog.Write($"Applying update from: {path}");
        Process.Start(new ProcessStartInfo
        {
            FileName = path,
            Arguments = "/SILENT /SUPPRESSMSGBOXES",
            UseShellExecute = true
        });

        System.Windows.Application.Current.Dispatcher.Invoke(() =>
        {
            System.Windows.Application.Current.Shutdown();
        });
    }

    private static string CleanVersionString(string raw)
    {
        var trimmed = raw.Trim().TrimStart('v', 'V');
        var dashIdx = trimmed.IndexOf('-');
        if (dashIdx > 0) trimmed = trimmed.Substring(0, dashIdx);
        return trimmed;
    }

    private static bool IsNewerVersion(string latestStr, string currentStr)
    {
        if (Version.TryParse(latestStr, out var latest) && Version.TryParse(currentStr, out var current))
        {
            return latest > current;
        }
        return !string.Equals(latestStr, currentStr, StringComparison.OrdinalIgnoreCase);
    }
}
