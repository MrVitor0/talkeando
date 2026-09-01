using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Velopack;

namespace Tupi.Client;

/// <summary>
/// The updater used by every post-bridge build. It intentionally never calls
/// GitHub's <c>/releases/latest</c>: that endpoint stays reserved for the
/// final Inno release so legacy clients cannot download a package they do not
/// understand.
/// </summary>
public sealed record UpdateInfo(
    string CurrentVersion,
    string LatestVersion,
    string ReleaseNotes,
    long FileSizeBytes
);

public sealed class UpdateChecker
{
    // An Inno-installed legacy bridge and local/dev executables are not
    // Velopack packages, so VelopackLocator.Current is unavailable there.
    // Constructing UpdateManager used to throw before the bridge could run
    // its migration, leaving the user with an application that immediately
    // crashed. Keep the updater unavailable in those contexts instead.
    private readonly UpdateManager? _manager;
    private Velopack.UpdateInfo? _available;

    public UpdateChecker()
    {
        try
        {
            _manager = new UpdateManager(ReleaseConfiguration.UpdateFeedUrl);
        }
        catch (Exception ex)
        {
            DebugLog.Write($"Velopack updater is unavailable in this installation: {ex.Message}");
        }
    }

    public static string GetCurrentVersion()
    {
        var ver = Assembly.GetExecutingAssembly().GetName().Version;
        return ver != null ? $"{ver.Major}.{ver.Minor}.{ver.Build}" : "0.1.0";
    }

    public async Task<UpdateInfo?> CheckAsync()
    {
        if (_manager is null)
            return null;

        try
        {
            _available = await _manager.CheckForUpdatesAsync();
            if (_available == null)
                return null;

            var target = _available.TargetFullRelease;
            return new UpdateInfo(
                _manager.CurrentVersion?.ToString() ?? GetCurrentVersion(),
                target.Version.ToString(),
                target.NotesMarkdown ?? string.Empty,
                target.Size
            );
        }
        catch (Exception ex)
        {
            // A dotnet/dev run is not a Velopack installation. It must stay
            // quiet rather than turning local development into an error modal.
            DebugLog.Write($"Velopack update check skipped/failed: {ex.Message}");
            return null;
        }
    }

    public async Task DownloadUpdateAsync(Action<int> onProgress, CancellationToken ct = default)
    {
        if (_manager is null)
            throw new InvalidOperationException("AtualizaÃ§Ã£o automÃ¡tica indisponÃ­vel nesta instalaÃ§Ã£o.");
        if (_available == null)
            throw new InvalidOperationException("Nenhuma atualizaÃ§Ã£o pendente para baixar.");

        await _manager.DownloadUpdatesAsync(_available, onProgress, ct);
    }

    public void ApplyUpdate()
    {
        if (_manager is null)
            throw new InvalidOperationException("AtualizaÃ§Ã£o automÃ¡tica indisponÃ­vel nesta instalaÃ§Ã£o.");
        if (_available == null)
            throw new InvalidOperationException("Nenhuma atualizaÃ§Ã£o baixada para aplicar.");

        // Velopack starts its own updater process, waits for this process to
        // end, atomically switches the package and launches the stable stub.
        _manager.ApplyUpdatesAndRestart(_available);
    }
}

internal static class ReleaseConfiguration
{
    private const string DefaultFeed = "https://github.com/MrVitor0/tupi/releases/download/tupi-update-feed";
    private const string DefaultBridgeSetup = DefaultFeed + "/Tupi.Client-Setup.exe";

    public static string UpdateFeedUrl =>
        Environment.GetEnvironmentVariable("TUPI_UPDATE_FEED_URL")
        ?? Metadata("Tupi.UpdateFeedUrl")
        ?? DefaultFeed;

    public static string LegacyMigrationSetupUrl =>
        Environment.GetEnvironmentVariable("TUPI_LEGACY_MIGRATION_SETUP_URL")
        ?? Metadata("Tupi.LegacyMigrationSetupUrl")
        ?? DefaultBridgeSetup;

    private static string? Metadata(string key) =>
        Assembly.GetExecutingAssembly()
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(attribute => attribute.Key == key)?.Value;
}

#if TUPI_LEGACY_BRIDGE
/// <summary>
/// Runs only in v0.1.999. Old clients reach this executable through their
/// existing Inno/GitHub-latest updater; this class then moves them to the
/// separate Velopack installation without exposing the new package format to
/// those old binaries.
/// </summary>
internal static class LegacyBridgeMigrator
{
    private static readonly HttpClient Http = new();

    public static async Task MigrateAsync()
    {
        var installedStub = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Tupi.Client", "Tupi.exe");
        if (File.Exists(installedStub))
        {
            DebugLog.Write("Legacy bridge found the Velopack install; redirecting legacy shortcut.");
            Process.Start(new ProcessStartInfo { FileName = installedStub, UseShellExecute = true });
            Environment.Exit(0);
            return;
        }

        var setupPath = Path.Combine(Path.GetTempPath(), "Tupi.Client-Setup.exe");
        DebugLog.Write($"Legacy bridge downloading Velopack setup from {ReleaseConfiguration.LegacyMigrationSetupUrl}");
        using var response = await Http.GetAsync(ReleaseConfiguration.LegacyMigrationSetupUrl, HttpCompletionOption.ResponseHeadersRead);
        response.EnsureSuccessStatusCode();
        await using (var source = await response.Content.ReadAsStreamAsync())
        await using (var destination = new FileStream(setupPath, FileMode.Create, FileAccess.Write, FileShare.None))
            await source.CopyToAsync(destination);

        Process.Start(new ProcessStartInfo
        {
            FileName = setupPath,
            Arguments = "--silent",
            UseShellExecute = true,
        });
        Environment.Exit(0);
    }
}
#endif
