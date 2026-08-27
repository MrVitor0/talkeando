using Talkeando.Client;
using Xunit;

namespace Talkeando.Client.Tests;

/// Every test uses its own temp file path — never the real
/// %LOCALAPPDATA%\Talkeando\session.bin (see SessionStore's constructor
/// doc comment). Running these tests must never touch a real installed
/// session on the machine running them.
public sealed class SessionStoreTests : IDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), $"talkeando-test-session-{Guid.NewGuid()}.bin");

    [Fact]
    public void HasToken_is_false_when_nothing_was_ever_saved()
    {
        var store = new SessionStore(_path);
        Assert.False(store.HasToken);
        Assert.Null(store.Load());
    }

    [Fact]
    public void Save_then_Load_round_trips_the_exact_token()
    {
        var store = new SessionStore(_path);
        store.Save("a-real-looking-session-token-value");

        Assert.True(store.HasToken);
        Assert.Equal("a-real-looking-session-token-value", store.Load());
    }

    [Fact]
    public void Clear_removes_the_token_and_the_file()
    {
        var store = new SessionStore(_path);
        store.Save("token-to-be-cleared");
        Assert.True(File.Exists(_path));

        store.Clear();

        Assert.False(File.Exists(_path));
        Assert.False(store.HasToken);
    }

    [Fact]
    public void A_corrupted_session_file_is_treated_as_no_session_and_self_heals()
    {
        // DPAPI-protected bytes are opaque; garbage bytes must fail
        // decryption cleanly rather than throw out of Load(), and the
        // store must not keep re-failing on every subsequent read.
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        File.WriteAllBytes(_path, new byte[] { 1, 2, 3, 4, 5 });

        var store = new SessionStore(_path);
        var loaded = store.Load();

        Assert.Null(loaded);
        Assert.False(File.Exists(_path), "a corrupted session file must be deleted, not left behind to fail forever");
    }

    [Fact]
    public void Saving_a_second_token_overwrites_the_first_not_appends()
    {
        var store = new SessionStore(_path);
        store.Save("first-token");
        store.Save("second-token");

        Assert.Equal("second-token", store.Load());
    }

    public void Dispose()
    {
        if (File.Exists(_path)) File.Delete(_path);
    }
}
