using Microsoft.Web.WebView2.Core;
using System.Text.Json;

namespace Talkeando.Client;

/// Sole native/UI boundary. Commands are envelope-shaped (`op`, `data`) and
/// every response is posted back as an event envelope, so the React UI never
/// sees session secrets or native WebRTC objects.
public sealed class IpcBridge
{
    public event EventHandler<string>? EventReady;
    private readonly SessionStore _sessions = new();

    public void HandleWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        try
        {
            using var document = JsonDocument.Parse(args.WebMessageAsJson);
            var root = document.RootElement;
            var op = root.GetProperty("op").GetString();
            switch (op)
            {
                case "auth.session.restore":
                    Publish("auth.state_changed", new { state = _sessions.HasToken ? "connecting" : "logged_out" });
                    break;
                case "auth.session.clear":
                    _sessions.Clear();
                    Publish("auth.state_changed", new { state = "logged_out" });
                    break;
                default:
                    Publish("error", new { code = "unknown_ipc_op", op });
                    break;
            }
        }
        catch (Exception exception)
        {
            Publish("error", new { code = "invalid_ipc_message", message = exception.Message });
        }
    }

    public void Publish(string op, object data) =>
        EventReady?.Invoke(this, JsonSerializer.Serialize(new { v = 1, op, data }));
}
