using Tupi.Client;
using Xunit;

namespace Tupi.Client.Tests;

public sealed class GracefulShutdownTests
{
    [Fact]
    public async Task Returns_true_when_the_ack_completes_before_the_timeout()
    {
        var ack = new TaskCompletionSource<bool>();
        var wait = GracefulShutdown.WaitForAckAsync(ack.Task, TimeSpan.FromSeconds(2));
        ack.SetResult(true);
        Assert.True(await wait);
    }

    [Fact]
    public async Task Returns_false_when_the_timeout_wins()
    {
        var neverAck = new TaskCompletionSource<bool>().Task;
        Assert.False(await GracefulShutdown.WaitForAckAsync(neverAck, TimeSpan.FromMilliseconds(50)));
    }
}
