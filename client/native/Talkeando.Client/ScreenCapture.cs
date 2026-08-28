using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Tupi.Client;

/// One selectable capture target shown in the in-app (Discord-style) picker.
/// `Thumbnail` is a small `data:image/jpeg;base64,...` URL so the React side
/// can render it directly.
public sealed record CaptureSource(string Id, string Kind, string Title, string Thumbnail);

/// Screen / window capture for screen share.
///
/// Deliberately NOT `getDisplayMedia`: that draws Chromium's non-removable
/// yellow "you are sharing" border and shows its own picker.
///
/// Two backends behind one API: Windows.Graphics.Capture (WgcCapture.cs) is
/// tried first — it handles fullscreen-exclusive games and GPU-composited
/// windows and pulls the cursor natively — and the GDI path here is the
/// fallback for sources WGC can't attach to (e.g. the whole virtual desktop)
/// or when WGC init fails.
///
/// Frames are emitted as JPEG, deduped against the previous frame (keyframe
/// every 1s). The host writes them into a WebView2 shared buffer; the UI
/// decodes each onto a &lt;canvas&gt; whose captureStream() becomes the
/// outbound WebRTC video track (see client/ui/src/rtc.ts).
public sealed class ScreenCapture : IDisposable
{
    // ---- P/Invoke ----------------------------------------------------------
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] private static extern IntPtr GetShellWindow();
    [DllImport("user32.dll", SetLastError = true)] private static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);
    [DllImport("user32.dll", SetLastError = true)] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out int value, int size);

    // Cursor compositing — GDI screen/window capture never includes the pointer.
    [DllImport("user32.dll")] private static extern bool GetCursorInfo(ref CURSORINFO pci);
    [DllImport("user32.dll")] private static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO piconinfo);
    [DllImport("user32.dll")] private static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr hIcon, int w, int h, int step, IntPtr brush, int flags);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr hObject);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }

    private const int GWL_STYLE = -16;
    private const int GWL_EXSTYLE = -20;
    private const long WS_CAPTION = 0x00C00000;
    private const long WS_EX_TOOLWINDOW = 0x00000080;
    private const int DWMWA_CLOAKED = 14;
    private const uint PW_RENDERFULLCONTENT = 0x00000002;
    private const int CURSOR_SHOWING = 0x00000001;
    private const int DI_NORMAL = 0x0003;

    private const uint GW_OWNER = 4;
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    // ---- enumeration -----------------------------------------------------
    public static List<CaptureSource> Enumerate()
    {
        var sources = new List<CaptureSource>();

        // Whole desktop first, then each physical monitor.
        var all = System.Windows.Forms.SystemInformation.VirtualScreen;
        sources.Add(new CaptureSource("screen:all", "screen", "Tela inteira",
            Thumbnail(() => GrabRectangle(all))));

        var screens = System.Windows.Forms.Screen.AllScreens;
        if (screens.Length > 1)
        {
            for (var i = 0; i < screens.Length; i++)
            {
                var bounds = screens[i].Bounds;
                var label = screens[i].Primary ? $"Monitor {i + 1} (principal)" : $"Monitor {i + 1}";
                sources.Add(new CaptureSource($"screen:{i}", "screen", label,
                    Thumbnail(() => GrabRectangle(bounds))));
            }
        }

        var shell = GetShellWindow();
        var ownPid = (uint)Environment.ProcessId;
        EnumWindows((hWnd, _) =>
        {
            if (hWnd == shell || !IsWindowVisible(hWnd) || IsIconic(hWnd)) return true;
            if (GetWindowTextLength(hWnd) == 0) return true;

            GetWindowThreadProcessId(hWnd, out var windowPid);
            if (windowPid == ownPid) return true;

            var style = GetWindowLong(hWnd, GWL_STYLE);
            var exStyle = GetWindowLong(hWnd, GWL_EXSTYLE);
            // Skip child windows (WS_CHILD = 0x40000000) and tool windows
            if ((style & 0x40000000) != 0) return true;
            if ((exStyle & WS_EX_TOOLWINDOW) == WS_EX_TOOLWINDOW) return true;

            // Only allow top-level root windows or windows without an active visible owner
            var owner = GetWindow(hWnd, GW_OWNER);
            if (owner != IntPtr.Zero && IsWindowVisible(owner)) return true;

            if (DwmGetWindowAttribute(hWnd, DWMWA_CLOAKED, out var cloaked, sizeof(int)) == 0 && cloaked != 0) return true;

            if (!GetWindowRect(hWnd, out var r)) return true;
            var w = r.Right - r.Left;
            var h = r.Bottom - r.Top;
            if (w < 160 || h < 120) return true;

            var className = new StringBuilder(256);
            GetClassName(hWnd, className, className.Capacity);
            var cls = className.ToString();
            if (cls is "Progman" or "Shell_TrayWnd" or "Windows.UI.Core.CoreWindow" or "MSCTFIME UI" or "Default IME") return true;

            var title = new StringBuilder(512);
            GetWindowText(hWnd, title, title.Capacity);
            var name = title.ToString().Trim();
            if (string.IsNullOrEmpty(name)) return true;
            if (name is "Tupi" || name.StartsWith("Tupi (") || name is "Talkeando" || name.StartsWith("Talkeando (")) return true;

            var handle = hWnd;
            sources.Add(new CaptureSource($"window:{hWnd.ToInt64()}", "window", name,
                Thumbnail(() => GrabWindow(handle))));
            return true;
        }, IntPtr.Zero);

        return sources;
    }

    /// Which process's audio to loop back for a given capture source:
    ///  - a window/game -> that window's process, INCLUDE its tree
    ///  - a whole screen -> WebView2 browser process (or our host), EXCLUDE its tree (everything
    ///    else the system plays, minus our own call voices, so no echo).
    public static (uint processId, int loopbackMode) ResolveAudioTarget(string sourceId, uint browserProcessId = 0)
    {
        if (sourceId.StartsWith("window:") && long.TryParse(sourceId.Substring("window:".Length), out var handle))
        {
            GetWindowThreadProcessId(new IntPtr(handle), out var pid);
            if (pid != 0) return (pid, AudioCapture.ModeIncludeTree);
        }
        var targetPid = browserProcessId != 0 ? browserProcessId : (uint)Environment.ProcessId;
        return (targetPid, AudioCapture.ModeExcludeTree);
    }

    private static string Thumbnail(Func<Bitmap?> grab)
    {
        try
        {
            using var full = grab();
            if (full is null || full.Width == 0 || full.Height == 0) return "";
            var scale = Math.Min(1f, 320f / full.Width);
            var tw = Math.Max(1, (int)(full.Width * scale));
            var th = Math.Max(1, (int)(full.Height * scale));
            using var small = new Bitmap(tw, th, PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(small))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBilinear;
                g.DrawImage(full, 0, 0, tw, th);
            }
            return "data:image/jpeg;base64," + Convert.ToBase64String(EncodeJpeg(small, 60L));
        }
        catch { return ""; }
    }

    // ---- capture loop -------------------------------------------------
    private Thread? _thread;
    private volatile bool _running;
    private string _sourceId = "";
    private int _maxHeight = 1080;
    private int _fps = 30;
    private Action<byte[]>? _onFrame;
    private WgcCapture? _wgc;

    // shared emit state (used by both the WGC and GDI backends)
    private readonly Stopwatch _emitClock = Stopwatch.StartNew();
    private readonly object _emitLock = new();
    private ulong _lastHash;
    private TimeSpan _lastSent = TimeSpan.MinValue;
    private TimeSpan _statWindowStart;
    private int _statSent, _statSkipped;
    private bool _loggedFirstOk;

    public bool IsRunning => _running;

    public void Start(string sourceId, int maxHeight, int fps, Action<byte[]> onFrame)
    {
        Stop();
        _sourceId = sourceId;
        _maxHeight = Math.Clamp(maxHeight, 240, 2160);
        _fps = Math.Clamp(fps, 5, 60);
        _onFrame = onFrame;
        _lastHash = 0;
        _lastSent = TimeSpan.MinValue;
        _statWindowStart = _emitClock.Elapsed;
        _statSent = _statSkipped = 0;
        _loggedFirstOk = false;
        _running = true;
        _thread = new Thread(Run) { IsBackground = true, Name = "screen-capture" };
        _thread.Start();
    }

    private void Run()
    {
        // Prefer WGC (fullscreen games, GPU-composited windows, native cursor);
        // fall back to the GDI loop if it can't attach to this source.
        // TUPI_DISABLE_WGC=1 forces the GDI path (escape hatch, no rebuild).
        if (Environment.GetEnvironmentVariable("TUPI_DISABLE_WGC") is "1" or "true")
        {
            DebugLog.Write("ScreenCapture: WGC disabled by env var, using GDI");
            GdiLoop();
            return;
        }
        _wgc = new WgcCapture();
        if (_wgc.TryStart(_sourceId, _fps, bmp => { using (bmp) EmitFrame(bmp, Point.Empty, nativeCursor: true); }))
        {
            while (_running && _wgc.IsRunning) Thread.Sleep(100);
            _wgc.Stop();
            _wgc = null;
            if (_running) GdiLoop(); // WGC dropped out (window closed etc.) — try GDI
            return;
        }
        _wgc.Stop();
        _wgc = null;
        GdiLoop();
    }

    public void Stop()
    {
        _running = false;
        try { _wgc?.Stop(); } catch { /* noop */ }
        _wgc = null;
        _thread?.Join(800);
        _thread = null;
        _onFrame = null;
    }

    private void GdiLoop()
    {
        var frameInterval = TimeSpan.FromSeconds(1.0 / _fps);
        var next = _emitClock.Elapsed;
        var loggedFirstErr = false;

        while (_running)
        {
            try
            {
                using var raw = GrabSource(_sourceId, out var origin);
                if (raw is not null) EmitFrame(raw, origin, nativeCursor: false);
                else if (!loggedFirstErr) { DebugLog.Write($"ScreenCapture: GrabSource('{_sourceId}') returned null"); loggedFirstErr = true; }
            }
            catch (Exception ex)
            {
                if (!loggedFirstErr) { DebugLog.Write($"ScreenCapture frame failed: {ex}"); loggedFirstErr = true; }
            }

            next += frameInterval;
            var wait = next - _emitClock.Elapsed;
            if (wait > TimeSpan.Zero) Thread.Sleep(wait);
            else next = _emitClock.Elapsed; // fell behind — reset cadence
        }
    }

    /// Shared by both backends: composite the cursor (GDI only), downscale,
    /// skip if unchanged (keyframe every 1s), JPEG-encode, hand to the host.
    private void EmitFrame(Bitmap raw, Point cursorOrigin, bool nativeCursor)
    {
        lock (_emitLock)
        {
            if (!_running) return;
            if (!nativeCursor) DrawCursor(raw, cursorOrigin);
            using var scaled = Downscale(raw, _maxHeight);
            var hash = HashBitmap(scaled);
            var now = _emitClock.Elapsed;

            if (hash == _lastHash && now - _lastSent < TimeSpan.FromSeconds(1))
            {
                _statSkipped++;
            }
            else
            {
                var jpeg = EncodeJpeg(scaled, 72L);
                _onFrame?.Invoke(jpeg);
                _lastHash = hash;
                _lastSent = now;
                _statSent++;
                if (!_loggedFirstOk) { DebugLog.Write($"ScreenCapture: first frame ({scaled.Width}x{scaled.Height}, {jpeg.Length} bytes)"); _loggedFirstOk = true; }
            }

            if (now - _statWindowStart >= TimeSpan.FromSeconds(5))
            {
                DebugLog.Write($"ScreenCapture: {_statSent} sent / {_statSkipped} skipped (unchanged) in last 5s");
                _statWindowStart = now; _statSent = 0; _statSkipped = 0;
            }
        }
    }

    private static Bitmap? GrabSource(string sourceId, out Point origin)
    {
        origin = Point.Empty;
        if (sourceId.StartsWith("screen:"))
        {
            var which = sourceId.Substring("screen:".Length);
            if (which == "all")
            {
                var vs = System.Windows.Forms.SystemInformation.VirtualScreen;
                origin = vs.Location;
                return GrabRectangle(vs);
            }
            if (int.TryParse(which, out var idx))
            {
                var screens = System.Windows.Forms.Screen.AllScreens;
                if (idx >= 0 && idx < screens.Length) { origin = screens[idx].Bounds.Location; return GrabRectangle(screens[idx].Bounds); }
            }
            return null;
        }
        if (sourceId.StartsWith("window:") && long.TryParse(sourceId.Substring("window:".Length), out var h))
        {
            var hWnd = new IntPtr(h);
            if (GetWindowRect(hWnd, out var wr)) origin = new Point(wr.Left, wr.Top);
            return GrabWindow(hWnd);
        }
        return null;
    }

    /// Composites the live mouse pointer onto `bmp`. `origin` is the capture
    /// area's top-left in screen coordinates.
    private static void DrawCursor(Bitmap bmp, Point origin)
    {
        var info = new CURSORINFO { cbSize = Marshal.SizeOf<CURSORINFO>() };
        if (!GetCursorInfo(ref info) || info.flags != CURSOR_SHOWING || info.hCursor == IntPtr.Zero) return;
        if (!GetIconInfo(info.hCursor, out var icon)) return;
        try
        {
            var x = info.ptScreenPos.X - origin.X - icon.xHotspot;
            var y = info.ptScreenPos.Y - origin.Y - icon.yHotspot;
            if (x >= bmp.Width || y >= bmp.Height || x < -64 || y < -64) return;
            using var g = Graphics.FromImage(bmp);
            var hdc = g.GetHdc();
            try { DrawIconEx(hdc, x, y, info.hCursor, 0, 0, 0, IntPtr.Zero, DI_NORMAL); }
            finally { g.ReleaseHdc(hdc); }
        }
        catch { /* cursor overlay is best-effort */ }
        finally
        {
            if (icon.hbmMask != IntPtr.Zero) DeleteObject(icon.hbmMask);
            if (icon.hbmColor != IntPtr.Zero) DeleteObject(icon.hbmColor);
        }
    }

    /// Cheap FNV-1a over a sparse pixel sample — enough to notice the screen
    /// (or cursor) changed and skip re-encoding an identical frame.
    private static ulong HashBitmap(Bitmap bmp)
    {
        var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        try
        {
            ulong hash = 14695981039346656037UL;
            var rowBytes = bmp.Width * 3;
            unsafe
            {
                var scan0 = (byte*)data.Scan0;
                for (var y = 0; y < bmp.Height; y += 2)
                {
                    var row = scan0 + y * data.Stride;
                    for (var x = 0; x < rowBytes; x += 12)
                    {
                        hash ^= row[x];
                        hash *= 1099511628211UL;
                    }
                }
            }
            return hash;
        }
        finally { bmp.UnlockBits(data); }
    }

    private static Bitmap GrabRectangle(Rectangle bounds)
    {
        var bmp = new Bitmap(Math.Max(1, bounds.Width), Math.Max(1, bounds.Height), PixelFormat.Format24bppRgb);
        using var g = Graphics.FromImage(bmp);
        g.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size, CopyPixelOperation.SourceCopy);
        return bmp;
    }

    private static Bitmap? GrabWindow(IntPtr hWnd)
    {
        if (!GetWindowRect(hWnd, out var r)) return null;
        var w = r.Right - r.Left;
        var h = r.Bottom - r.Top;
        if (w <= 0 || h <= 0) return null;

        var bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb);
        using (var g = Graphics.FromImage(bmp))
        {
            var hdc = g.GetHdc();
            try { PrintWindow(hWnd, hdc, PW_RENDERFULLCONTENT); }
            finally { g.ReleaseHdc(hdc); }
        }

        // PrintWindow returns an all-black bitmap for some GPU-composited
        // windows; fall back to copying that window's screen rectangle.
        if (IsMostlyBlack(bmp))
        {
            bmp.Dispose();
            return GrabRectangle(new Rectangle(r.Left, r.Top, w, h));
        }
        return bmp;
    }

    private static bool IsMostlyBlack(Bitmap bmp)
    {
        var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        try
        {
            var nonBlack = 0;
            var stride = data.Stride;
            unsafe
            {
                var scan0 = (byte*)data.Scan0;
                // Sample a sparse grid — full scan is wasteful just to detect black.
                for (var y = 0; y < bmp.Height; y += 16)
                {
                    var row = scan0 + y * stride;
                    for (var x = 0; x < bmp.Width; x += 16)
                    {
                        var p = row + x * 3;
                        if (p[0] > 8 || p[1] > 8 || p[2] > 8) { nonBlack++; if (nonBlack > 32) return false; }
                    }
                }
            }
            return true;
        }
        finally { bmp.UnlockBits(data); }
    }

    private static Bitmap Downscale(Bitmap source, int maxHeight)
    {
        if (source.Height <= maxHeight) return (Bitmap)source.Clone();
        var scale = (float)maxHeight / source.Height;
        var w = Math.Max(2, (int)(source.Width * scale) & ~1);   // even dims — friendlier to encoders
        var h = Math.Max(2, maxHeight & ~1);
        var dst = new Bitmap(w, h, PixelFormat.Format24bppRgb);
        using var g = Graphics.FromImage(dst);
        g.InterpolationMode = InterpolationMode.HighQualityBilinear;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.DrawImage(source, 0, 0, w, h);
        return dst;
    }

    private static ImageCodecInfo? _jpegCodec;
    private static byte[] EncodeJpeg(Bitmap bmp, long quality)
    {
        _jpegCodec ??= Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.FormatID == ImageFormat.Jpeg.Guid);
        using var ms = new MemoryStream();
        if (_jpegCodec is not null)
        {
            using var p = new EncoderParameters(1);
            p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
            bmp.Save(ms, _jpegCodec, p);
        }
        else
        {
            bmp.Save(ms, ImageFormat.Jpeg);
        }
        return ms.ToArray();
    }

    public void Dispose() => Stop();
}
