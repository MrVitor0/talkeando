using Talkeando.Client;
using Xunit;

namespace Talkeando.Client.Tests;

/// Deliberately scoped to logic that does not touch real hardware (no
/// microphone capture, no GDI screen capture, no actual network/ICE) —
/// this project has no CI runner with guaranteed audio/display devices.
/// Constructing `RtcEngine` only builds encoder/format state (verified in
/// SDD/27-decisions.md's reflection work), it does not open any device
/// until StartMicrophoneAsync/PublishScreen are called, which these tests
/// avoid. Live audio/video/ICE behavior needs the manual two-machine test
/// pass documented in SDD/31-implementation-status.md, not a unit test.
public sealed class RtcEngineTests : IDisposable
{
    private readonly RtcEngine _engine = new();

    [Fact]
    public void Starts_muted_by_default()
    {
        // AUDIO-FR: joining a call must never transmit before the user has
        // explicitly unmuted — see IpcBridge.HandleWebMessage's call.join
        // case, which relies on this default.
        Assert.True(_engine.IsMuted);
        Assert.False(_engine.IsDeafened);
    }

    [Fact]
    public void SetMuted_and_SetDeafened_are_independent_flags()
    {
        _engine.SetMuted(false);
        _engine.SetDeafened(true);

        Assert.False(_engine.IsMuted);
        Assert.True(_engine.IsDeafened);

        // Undeafening must not silently un-mute — IpcBridge is responsible
        // for restoring the user's actual mute preference, RtcEngine must
        // not invent one (see RtcEngine.cs SetDeafened doc comment).
        _engine.SetDeafened(false);
        Assert.False(_engine.IsMuted);
    }

    [Fact]
    public void RemovePeer_on_a_peer_that_was_never_created_is_a_safe_no_op()
    {
        var neverConnected = Guid.NewGuid();
        var exception = Record.Exception(() => _engine.RemovePeer(neverConnected));

        Assert.Null(exception);
        Assert.False(_engine.HasPeer(neverConnected));
    }

    [Fact]
    public async Task LeaveCallAsync_with_no_active_peers_is_a_safe_no_op()
    {
        var exception = await Record.ExceptionAsync(() => _engine.LeaveCallAsync());
        Assert.Null(exception);
    }

    [Fact]
    public void SetScreenSubscription_for_an_unpublished_stream_is_a_safe_no_op()
    {
        // A late/duplicate stream.subscription_requested for a stream that
        // was already unpublished (race between unpublish and a pending
        // subscribe) must not throw or fabricate a share entry.
        var unpublishedStreamId = Guid.NewGuid();
        var subscriber = Guid.NewGuid();

        var exception = Record.Exception(() => _engine.SetScreenSubscription(unpublishedStreamId, subscriber, subscribed: true));

        Assert.Null(exception);
        Assert.False(_engine.HasSubscriber(unpublishedStreamId, subscriber));
        Assert.False(_engine.IsStreamPublished(unpublishedStreamId));
    }

    [Fact]
    public void UnpublishScreen_for_a_stream_that_was_never_published_is_a_safe_no_op()
    {
        var exception = Record.Exception(() => _engine.UnpublishScreen(Guid.NewGuid()));
        Assert.Null(exception);
    }

    [Fact]
    public void ListMonitors_never_throws_and_returns_a_readable_list()
    {
        // Whole-monitor GDI capture per SDD/27-decisions.md ADR-003. This
        // only enumerates monitors (System.Windows.Forms.Screen.AllScreens)
        // — it must not throw even in a session with unusual display state,
        // and every entry must have plausible (non-negative) dimensions.
        var exception = Record.Exception(() =>
        {
            var monitors = RtcEngine.ListMonitors();
            foreach (var monitor in monitors)
            {
                Assert.True(monitor.Width >= 0);
                Assert.True(monitor.Height >= 0);
            }
        });

        Assert.Null(exception);
    }

    public void Dispose() => _engine.Dispose();
}
