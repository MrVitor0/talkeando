using System.Diagnostics;

namespace Tupi.Client;

/// <summary>Small, local-only music source. yt-dlp resolves a URL/search and
/// ffmpeg normalizes it to the same 48 kHz stereo PCM contract as screen audio.
/// No media bytes ever pass through the Tupi server.</summary>
public sealed class MusicPlayback : IDisposable
{
    private readonly object _gate = new();
    private CancellationTokenSource? _cancel;
    private Process? _ytDlp, _ffmpeg;
    private bool _paused;

    public async Task PlayAsync(string query, Action<byte[]> onPcm, Action<string> onStarted, Action<string> onError)
    {
        Stop();
        var cancel = new CancellationTokenSource();
        lock (_gate) _cancel = cancel;
        try
        {
            // A plain text query is intentionally resolved by yt-dlp itself.
            // It also accepts YouTube playlist URLs and plays their entries in order.
            var source = Uri.TryCreate(query, UriKind.Absolute, out _) ? query : $"ytsearch1:{query}";
            var ytdlp = Start("yt-dlp", $"--no-progress -f bestaudio -o - {Quote(source)}");
            var ffmpeg = Start("ffmpeg", "-hide_banner -loglevel error -i pipe:0 -f s16le -ar 48000 -ac 2 pipe:1");
            lock (_gate) { _ytDlp = ytdlp; _ffmpeg = ffmpeg; }
            var copy = ytdlp.StandardOutput.BaseStream.CopyToAsync(ffmpeg.StandardInput.BaseStream, cancel.Token);
            _ = copy.ContinueWith(_ => { try { ffmpeg.StandardInput.Close(); } catch { } });
            onStarted(query);
            var buffer = new byte[7680]; // 20 ms of 48kHz stereo s16
            while (!cancel.IsCancellationRequested)
            {
                // Back-pressure ffmpeg/yt-dlp while paused instead of dropping
                // decoded data, so resume continues from the same position.
                while (IsPaused && !cancel.IsCancellationRequested)
                    await Task.Delay(50, cancel.Token);
                var read = await ffmpeg.StandardOutput.BaseStream.ReadAsync(buffer.AsMemory(), cancel.Token);
                if (read == 0) break;
                var pcm = new byte[read];
                Buffer.BlockCopy(buffer, 0, pcm, 0, read);
                onPcm(pcm);
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) { DebugLog.Write($"MusicPlayback failed: {ex}"); onError(ex.Message); }
        finally
        {
            // Do not let an older decoder task tear down a newer /play.
            bool isCurrent;
            lock (_gate) isCurrent = ReferenceEquals(_cancel, cancel);
            if (isCurrent) Stop();
        }
    }

    public void Pause(bool paused) { lock (_gate) _paused = paused; }
    // UI drops PCM while paused; keeping the decoder alive avoids platform-specific process suspension.
    public bool IsPaused { get { lock (_gate) return _paused; } }
    public void Stop()
    {
        CancellationTokenSource? cancel; Process? yt; Process? ff;
        lock (_gate) { cancel = _cancel; _cancel = null; yt = _ytDlp; _ytDlp = null; ff = _ffmpeg; _ffmpeg = null; _paused = false; }
        cancel?.Cancel();
        foreach (var process in new[] { yt, ff }) try { if (process is { HasExited: false }) process.Kill(true); process?.Dispose(); } catch { }
        cancel?.Dispose();
    }
    private static Process Start(string file, string args) => Process.Start(new ProcessStartInfo(file, args) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardInput = true, RedirectStandardError = true, CreateNoWindow = true }) ?? throw new InvalidOperationException($"Não foi possível iniciar {file}. Instale-o ou inclua-o ao lado do Tupi.");
    private static string Quote(string text) => $"\"{text.Replace("\"", "\\\"")}\"";
    public void Dispose() => Stop();
}
