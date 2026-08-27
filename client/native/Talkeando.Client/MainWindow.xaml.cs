using Microsoft.Web.WebView2.Core;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;

namespace Talkeando.Client;

public partial class MainWindow : System.Windows.Window
{
    private readonly IpcBridge _bridge = new();
    private CoreWebView2Environment? _environment;
    // Default centre-of-titlebar caption; replaced with the community name once
    // the UI reports it (host.title).
    private readonly string _baseTitle;
    // Window.Loaded can fire more than once (WebView2 is an HwndHost); the
    // handlers wired below must be attached exactly once or every IPC event
    // is delivered twice and WebRTC signalling desyncs ("wrong state:
    // stable").
    private bool _initialized;

    // Screen-capture frame transport: one shared buffer split into two slots
    // (see ScreenCapture.cs / client/ui/src/nativeScreen.ts). The host writes
    // a JPEG into an alternating slot each frame; the WebView reads it back
    // out of the same memory, so nothing large crosses the IPC channel.
    private const int FrameSlots = 2;
    private const int FrameSlotSize = 2 * 1024 * 1024;
    private CoreWebView2SharedBuffer? _frameBuffer;
    private readonly object _frameLock = new();

    // Screen-capture audio transport (WASAPI process loopback -> AudioCapture.cs).
    // Small ring of slots, one WASAPI packet (~10 ms of 48 kHz stereo s16 =
    // ~1920 bytes) per slot.
    private const int AudioSlots = 16;
    private const int AudioSlotSize = 8 * 1024;
    private CoreWebView2SharedBuffer? _audioBuffer;
    private readonly object _audioLock = new();

    public MainWindow()
    {
        InitializeComponent();
        _baseTitle = Profile.Suffix.Length > 0
            ? $"Talkeando ({Profile.Suffix.TrimStart('-')})"
            : "Talkeando";
        Title = _baseTitle;
        TitleText.Text = _baseTitle;
        // The UI tells us the active community name so the custom title bar can
        // read like Discord's ("Estação Finita") instead of a static string.
        _bridge.HostTitleChanged += (_, name) => Dispatcher.Invoke(() =>
        {
            var text = string.IsNullOrWhiteSpace(name) ? _baseTitle : name.Trim();
            var suffix = Profile.Suffix.Length > 0 ? $" · {Profile.Suffix.TrimStart('-')}" : "";
            TitleText.Text = text + suffix;
            Title = text + suffix;
        });
        Loaded += async (_, _) => await InitializeWebViewAsync();
        // Release the microphone and every RTCPeerConnection when the window
        // closes — otherwise WASAPI capture keeps the mic device open after
        // the app exits until process teardown.
        Closed += (_, _) => _bridge.Dispose();
    }

    // ---- custom title bar --------------------------------------------------

    private void Minimize_Click(object sender, RoutedEventArgs e)
        => WindowState = WindowState.Minimized;

    private void MaxRestore_Click(object sender, RoutedEventArgs e)
        => WindowState = WindowState == WindowState.Maximized
            ? WindowState.Normal
            : WindowState.Maximized;

    private void Close_Click(object sender, RoutedEventArgs e) => Close();

    private void Back_Click(object sender, RoutedEventArgs e)
    {
        if (WebView.CoreWebView2?.CanGoBack == true) WebView.CoreWebView2.GoBack();
    }

    private void Forward_Click(object sender, RoutedEventArgs e)
    {
        if (WebView.CoreWebView2?.CanGoForward == true) WebView.CoreWebView2.GoForward();
    }

    /// Just swap the maximise/restore glyph. The maximised *size* is clamped to
    /// the monitor work area in WndProc (WM_GETMINMAXINFO) below, so a
    /// borderless window no longer spills under the taskbar or past the screen
    /// edges — and so needs no compensating padding on the content.
    protected override void OnStateChanged(EventArgs e)
    {
        base.OnStateChanged(e);
        var maximized = WindowState == WindowState.Maximized;
        MaxButton.Content = maximized ? "" : ""; // ChromeRestore : ChromeMaximize
        MaxButton.ToolTip = maximized ? "Restaurar" : "Maximizar";
    }

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        var handle = new WindowInteropHelper(this).Handle;
        HwndSource.FromHwnd(handle)?.AddHook(WndProc);
    }

    private const int WM_GETMINMAXINFO = 0x0024;
    private const int MONITOR_DEFAULTTONEAREST = 0x00000002;

    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg != WM_GETMINMAXINFO) return IntPtr.Zero;

        var monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if (monitor == IntPtr.Zero) return IntPtr.Zero;

        var info = new MonitorInfo();
        if (!GetMonitorInfo(monitor, info)) return IntPtr.Zero;

        var mmi = Marshal.PtrToStructure<MinMaxInfo>(lParam);
        // Maximise to the work area (screen minus taskbar), top-left of it,
        // expressed relative to the monitor's own origin.
        mmi.ptMaxPosition.X = info.rcWork.left - info.rcMonitor.left;
        mmi.ptMaxPosition.Y = info.rcWork.top - info.rcMonitor.top;
        mmi.ptMaxSize.X = info.rcWork.right - info.rcWork.left;
        mmi.ptMaxSize.Y = info.rcWork.bottom - info.rcWork.top;

        var dpi = VisualTreeHelper.GetDpi(this);
        mmi.ptMinTrackSize.X = (int)(MinWidth * dpi.DpiScaleX);
        mmi.ptMinTrackSize.Y = (int)(MinHeight * dpi.DpiScaleY);

        Marshal.StructureToPtr(mmi, lParam, true);
        return IntPtr.Zero;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hwnd, int flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, MonitorInfo lpmi);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect { public int left; public int top; public int right; public int bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MinMaxInfo
    {
        public NativePoint ptReserved;
        public NativePoint ptMaxSize;
        public NativePoint ptMaxPosition;
        public NativePoint ptMinTrackSize;
        public NativePoint ptMaxTrackSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    private sealed class MonitorInfo
    {
        public int cbSize = Marshal.SizeOf(typeof(MonitorInfo));
        public NativeRect rcMonitor;
        public NativeRect rcWork;
        public int dwFlags;
    }

    private void UpdateNavButtons()
    {
        var core = WebView.CoreWebView2;
        BackButton.IsEnabled = core?.CanGoBack == true;
        ForwardButton.IsEnabled = core?.CanGoForward == true;
    }

    /// WebView2 initialization has two failure modes that previously left
    /// the app silently stuck forever with no window content and no log:
    /// the WebView2 Runtime not being installed (throws), and — less
    /// obviously — the default user-data-folder location (next to the exe)
    /// being unwritable, which can hang rather than throw promptly on some
    /// machines/drive types. Both are now surfaced with a real error
    /// message instead of silence, and a hang can no longer last forever.
    private async Task InitializeWebViewAsync()
    {
        if (_initialized) { DebugLog.Write("InitializeWebViewAsync: already initialized, skipping"); return; }
        _initialized = true;
        try
        {
            DebugLog.Write("InitializeWebViewAsync: starting");
            var userDataFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Talkeando", $"WebView2{Profile.Suffix}");
            Directory.CreateDirectory(userDataFolder);
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: userDataFolder);
            _environment = environment;

            var initialization = WebView.EnsureCoreWebView2Async(environment);
            var timeout = Task.Delay(TimeSpan.FromSeconds(15));
            if (await Task.WhenAny(initialization, timeout) == timeout)
                throw new TimeoutException("WebView2 não respondeu em 15s ao inicializar (verifique o WebView2 Runtime).");
            await initialization; // observe/propagate a real failure if that's what happened instead of a timeout

            DebugLog.Write("InitializeWebViewAsync: CoreWebView2 ready, wiring WebMessageReceived");
            WebView.CoreWebView2.WebMessageReceived += _bridge.HandleWebMessage;
            _bridge.EventReady += (_, json) => Dispatcher.InvokeAsync(() => WebView.CoreWebView2.PostWebMessageAsJson(json));

            // Suppress Chromium's built-in right-click menu everywhere — the UI
            // draws its own context menus (rename channel / member / avatar).
            WebView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;

            // Keep the custom title bar's back/forward arrows in sync with the
            // WebView's real navigation history.
            WebView.CoreWebView2.HistoryChanged += (_, _) => Dispatcher.Invoke(UpdateNavButtons);
            UpdateNavButtons();

            // Voice calls need the microphone via getUserMedia in
            // client/ui/src/rtc.ts (WebRTC now runs in this Chromium engine,
            // not in native C# — see SDD/27-decisions.md ADR-009). This is
            // our own bundled UI, not third-party content, so auto-allow
            // instead of surfacing WebView2's own permission bar inside a
            // window that already looks like a native app.
            // getDisplayMedia (screen share) is unaffected by this handler —
            // Chromium shows its own built-in source picker for that
            // regardless, no PermissionRequested prompt involved.
            WebView.CoreWebView2.PermissionRequested += (_, permissionArgs) =>
            {
                if (permissionArgs.PermissionKind == CoreWebView2PermissionKind.Microphone)
                    permissionArgs.State = CoreWebView2PermissionState.Allow;
            };

            // Navigating straight to a file:// URL renders a blank page here:
            // the built UI's entry script is an ES module (Vite's default
            // output), and Chromium (WebView2 included) refuses to load
            // module scripts from file:// due to CORS — confirmed by
            // inspecting the actual blank window (white background, meaning
            // even the stylesheet never applied; a real error page would
            // have shown visible text instead). The documented fix is to
            // serve the local folder over a virtual HTTPS-like origin
            // instead of file://, which WebView2 supports natively.
            var uiFolder = Path.Combine(AppContext.BaseDirectory, "ui");
            WebView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                "talkeando.local", uiFolder, CoreWebView2HostResourceAccessKind.Allow);

            // Hand the UI its screen-capture shared buffer once the page's
            // module scripts have registered their `sharedbufferreceived`
            // listener (i.e. after the first navigation completes).
            WebView.CoreWebView2.NavigationCompleted += (_, _) => SetUpFrameBuffer();

            WebView.CoreWebView2.Navigate("https://talkeando.local/index.html");
            DebugLog.Write("InitializeWebViewAsync: navigated, publishing host.ready");
            _bridge.Publish("host.ready", new { });
        }
        catch (Exception exception)
        {
            DebugLog.Write($"InitializeWebViewAsync FAILED: {exception}");
            System.Diagnostics.Debug.WriteLine($"WebView2 initialization failed: {exception}");
            System.Windows.MessageBox.Show(
                this,
                "Não foi possível iniciar o WebView2.\n\n" +
                "Isso normalmente significa que o WebView2 Runtime não está instalado. " +
                "Baixe e instale o 'Evergreen Bootstrapper' em https://developer.microsoft.com/microsoft-edge/webview2/ " +
                "e abra o Talkeando novamente.\n\n" +
                $"Detalhe técnico: {exception.Message}",
                "Talkeando — falha ao iniciar",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            Close();
        }
    }

    private void SetUpFrameBuffer()
    {
        if (_frameBuffer is not null || _environment is null) return;
        try
        {
            _frameBuffer = _environment.CreateSharedBuffer((ulong)(FrameSlots * FrameSlotSize));
            WebView.CoreWebView2.PostSharedBufferToScript(
                _frameBuffer,
                CoreWebView2SharedBufferAccess.ReadOnly,
                $"{{\"kind\":\"screen-frames\",\"slots\":{FrameSlots},\"slotSize\":{FrameSlotSize}}}");

            // Write straight into the shared memory via its native pointer.
            // The Stream from OpenStream() is not seekable/writable on the
            // host side once the buffer is posted ReadOnly to script — setting
            // Position on it throws NotSupportedException.
            var basePtr = _frameBuffer.Buffer;
            _bridge.WriteFrameSlot = (jpeg, slot) =>
            {
                if (jpeg.Length > FrameSlotSize) return;
                lock (_frameLock)
                {
                    Marshal.Copy(jpeg, 0, basePtr + slot * FrameSlotSize, jpeg.Length);
                }
            };
            _audioBuffer = _environment.CreateSharedBuffer((ulong)(AudioSlots * AudioSlotSize));
            WebView.CoreWebView2.PostSharedBufferToScript(
                _audioBuffer,
                CoreWebView2SharedBufferAccess.ReadOnly,
                $"{{\"kind\":\"screen-audio\",\"slots\":{AudioSlots},\"slotSize\":{AudioSlotSize},\"sampleRate\":{AudioCapture.SampleRate},\"channels\":{AudioCapture.Channels}}}");
            var audioBasePtr = _audioBuffer.Buffer;
            _bridge.AudioSlotCount = AudioSlots;
            _bridge.WriteAudioSlot = (pcm, slot) =>
            {
                if (pcm.Length > AudioSlotSize) return;
                lock (_audioLock)
                {
                    Marshal.Copy(pcm, 0, audioBasePtr + slot * AudioSlotSize, pcm.Length);
                }
            };

            DebugLog.Write("SetUpFrameBuffer: screen-capture video + audio shared buffers posted to script");
        }
        catch (Exception exception)
        {
            DebugLog.Write($"SetUpFrameBuffer FAILED: {exception}");
        }
    }
}
