using Microsoft.Web.WebView2.Core;
using System.IO;

namespace Talkeando.Client;

public partial class MainWindow : System.Windows.Window
{
    private readonly IpcBridge _bridge = new();

    public MainWindow()
    {
        InitializeComponent();
        Loaded += async (_, _) =>
        {
            await WebView.EnsureCoreWebView2Async();
            WebView.CoreWebView2.WebMessageReceived += _bridge.HandleWebMessage;
            _bridge.EventReady += (_, json) => WebView.CoreWebView2.PostWebMessageAsJson(json);

            var indexPath = Path.Combine(AppContext.BaseDirectory, "ui", "index.html");
            WebView.CoreWebView2.Navigate(new Uri(indexPath).AbsoluteUri);
            _bridge.Publish("host.ready", new { });
        };
    }
}
