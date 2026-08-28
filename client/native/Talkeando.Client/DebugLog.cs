using System.IO;

namespace Tupi.Client;

/// Temporary diagnostic logging (2026-08-27), shared by IpcBridge and
/// RtcEngine — writes to a plain file because a WinExe app's
/// Console.WriteLine is not reliably visible in every terminal type (found
/// the hard way while debugging a "login does nothing" report that turned
/// out to be unrelated). One file per TUPI_PROFILE so two local test
/// instances don't interleave into the same log. Delete once the current
/// "screen share never renders a frame" investigation is resolved.
internal static class DebugLog
{
    public static readonly string Path = System.IO.Path.Combine(
        System.IO.Path.GetTempPath(), $"tupi-debug{Profile.Suffix}.log");

    static DebugLog()
    {
        // Diagnostic files are session-scoped. Keeping hundreds of megabytes
        // from previous runs made the first synchronous append visibly stall.
        try { File.WriteAllText(Path, string.Empty); } catch { /* best effort */ }
    }

    public static void Write(string message)
    {
        try { File.AppendAllText(Path, $"{DateTime.Now:HH:mm:ss.fff} {message}\n"); } catch { /* best effort */ }
    }
}
