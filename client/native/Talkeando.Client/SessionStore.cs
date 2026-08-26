using System.Security.Cryptography;
using System.Text;

namespace Talkeando.Client;

/// DPAPI-backed token persistence. The browser layer receives session state,
/// never the bearer token itself.
public sealed class SessionStore
{
    private static readonly string Path = System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Talkeando", "session.bin");

    public bool HasToken => Load() is not null;

    public void Save(string token)
    {
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);
        var protectedBytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(token), null, DataProtectionScope.CurrentUser);
        File.WriteAllBytes(Path, protectedBytes);
    }

    public string? Load()
    {
        if (!File.Exists(Path)) return null;
        try { return Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(Path), null, DataProtectionScope.CurrentUser)); }
        catch (CryptographicException) { Clear(); return null; }
    }

    public void Clear() { if (File.Exists(Path)) File.Delete(Path); }
}
