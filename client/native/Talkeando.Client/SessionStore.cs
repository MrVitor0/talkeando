using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace Talkeando.Client;

/// DPAPI-backed token persistence. The browser layer receives session state,
/// never the bearer token itself.
public sealed class SessionStore
{
    private static readonly string DefaultPath = System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Talkeando", "session.bin");

    private readonly string _path;

    /// `path` is only ever overridden by tests — production always uses the
    /// real per-user DPAPI file (`DefaultPath`). Never point this at a path
    /// shared with a real installation: `Clear()` deletes it outright.
    public SessionStore(string? path = null)
    {
        _path = path ?? DefaultPath;
    }

    public bool HasToken => Load() is not null;

    public void Save(string token)
    {
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(_path)!);
        var protectedBytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(token), null, DataProtectionScope.CurrentUser);
        File.WriteAllBytes(_path, protectedBytes);
    }

    public string? Load()
    {
        if (!File.Exists(_path)) return null;
        try { return Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(_path), null, DataProtectionScope.CurrentUser)); }
        catch (CryptographicException) { Clear(); return null; }
    }

    public void Clear() { if (File.Exists(_path)) File.Delete(_path); }
}
