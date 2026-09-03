namespace Tupi.Client;

/// The wait half of the graceful-shutdown handshake, pulled out of
/// <see cref="IpcBridge"/> (which needs WebView2) so it can be unit-tested.
public static class GracefulShutdown
{
    /// Returns true if <paramref name="ack"/> completed within
    /// <paramref name="timeout"/>, false if the timeout won the race.
    public static async Task<bool> WaitForAckAsync(Task ack, TimeSpan timeout)
        => await Task.WhenAny(ack, Task.Delay(timeout)).ConfigureAwait(false) == ack;
}
