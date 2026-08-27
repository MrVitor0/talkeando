namespace Talkeando.Client;

/// Lets multiple instances of this app run side by side on one machine as
/// genuinely separate identities — needed for local dev/testing with two
/// accounts, since a real deployment has one user per machine and never
/// needs this. Without it, every instance shares one hardcoded session file
/// and one hardcoded WebView2 profile folder, so a second login silently
/// overwrites the first (a real bug found while testing two windows on one
/// PC, not a hypothetical). Set TALKEANDO_PROFILE to any short name (e.g.
/// "alice", "bob") before `dotnet run` to isolate an instance; leave it
/// unset for the normal single-profile case.
internal static class Profile
{
    public static string Suffix { get; } =
        Environment.GetEnvironmentVariable("TALKEANDO_PROFILE") is { Length: > 0 } name
            ? $"-{name}"
            : string.Empty;
}
