namespace Tupi.Client;

public partial class App : System.Windows.Application
{
    protected override void OnStartup(System.Windows.StartupEventArgs e)
    {
#if !TUPI_LEGACY_BRIDGE
        // Must run before any WPF/WebView2 window is created. In a real
        // Velopack install this handles update housekeeping and hooks; direct
        // local/dev runs remain supported and have updates disabled by script.
        Velopack.VelopackApp.Build().Run();
#endif
        base.OnStartup(e);
        var window = new MainWindow();
        MainWindow = window;
        window.Show();
    }
}
