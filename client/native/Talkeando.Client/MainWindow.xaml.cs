using Microsoft.Web.WebView2.Core;
using System.IO;
using System.Windows;

namespace Talkeando.Client;

public partial class MainWindow : System.Windows.Window
{
    private readonly IpcBridge _bridge = new();

    public MainWindow()
    {
        InitializeComponent();
        if (Profile.Suffix.Length > 0) Title = $"Talkeando ({Profile.Suffix.TrimStart('-')})";
        Loaded += async (_, _) => await InitializeWebViewAsync();
        // Release the microphone and every RTCPeerConnection when the window
        // closes — otherwise WASAPI capture keeps the mic device open after
        // the app exits until process teardown.
        Closed += (_, _) => _bridge.Dispose();
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
        try
        {
            DebugLog.Write("InitializeWebViewAsync: starting");
            var userDataFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Talkeando", $"WebView2{Profile.Suffix}");
            Directory.CreateDirectory(userDataFolder);
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: userDataFolder);

            var initialization = WebView.EnsureCoreWebView2Async(environment);
            var timeout = Task.Delay(TimeSpan.FromSeconds(15));
            if (await Task.WhenAny(initialization, timeout) == timeout)
                throw new TimeoutException("WebView2 não respondeu em 15s ao inicializar (verifique o WebView2 Runtime).");
            await initialization; // observe/propagate a real failure if that's what happened instead of a timeout

            DebugLog.Write("InitializeWebViewAsync: CoreWebView2 ready, wiring WebMessageReceived");
            WebView.CoreWebView2.WebMessageReceived += _bridge.HandleWebMessage;
            _bridge.EventReady += (_, json) => Dispatcher.InvokeAsync(() => WebView.CoreWebView2.PostWebMessageAsJson(json));

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
}
