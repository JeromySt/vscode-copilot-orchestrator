// <copyright file="SecureTempScript.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Shell.Temp;

/// <summary>
/// CMD-TMP-1: atomically creates a per-run script file with owner-only access.
/// On Linux/macOS the file is opened via <see cref="FileMode.CreateNew"/> (which maps
/// to <c>open(O_CREAT|O_EXCL|O_WRONLY|O_CLOEXEC)</c>) and chmod'd to <c>0600</c>.
/// On Windows the file is opened via <see cref="FileMode.CreateNew"/> (which maps to
/// <c>CreateFileW(CREATE_NEW)</c>) and a DACL granting only the current user
/// read+execute is applied.
/// </summary>
internal sealed class SecureTempScript : IAsyncDisposable
{
    private readonly AbsolutePath tempDir;
    private AbsolutePath? path;
    private long byteLength;
    private int disposed;

    /// <summary>Initializes a new instance of the <see cref="SecureTempScript"/> class.</summary>
    /// <param name="tempDir">The directory in which to create the temp script.</param>
    public SecureTempScript(AbsolutePath tempDir)
    {
        this.tempDir = tempDir;
    }

    /// <summary>Gets the path of the created script, or <see langword="null"/> if not created yet.</summary>
    public AbsolutePath? Path => this.path;

    /// <summary>Atomically creates the temp script, writes <paramref name="contents"/>, and applies owner-only ACLs.</summary>
    /// <param name="contents">The script body bytes to write (UTF-8 typically).</param>
    /// <param name="fileExtension">Required file extension including the leading dot (e.g. <c>.ps1</c>, <c>.sh</c>, <c>.cmd</c>).</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The absolute path of the newly created file.</returns>
    /// <exception cref="ArgumentException">If <paramref name="fileExtension"/> is missing or doesn't start with '.'.</exception>
    /// <exception cref="InvalidOperationException">If a script has already been created on this instance.</exception>
    public async ValueTask<AbsolutePath> CreateAsync(
        ReadOnlyMemory<byte> contents,
        string fileExtension,
        CancellationToken ct)
    {
        if (string.IsNullOrEmpty(fileExtension) || fileExtension[0] != '.')
        {
            throw new ArgumentException("File extension must be non-empty and begin with '.'.", nameof(fileExtension));
        }

        if (this.path is not null)
        {
            throw new InvalidOperationException("SecureTempScript.CreateAsync may only be called once per instance.");
        }

        var fileName = $"orca-shell-{Guid.NewGuid():N}{fileExtension}";
        var fullPath = System.IO.Path.Combine(this.tempDir.Value, fileName);

        // INV-6 / CMD-TMP-1: FileMode.CreateNew maps to O_CREAT|O_EXCL on Unix and CREATE_NEW on Windows.
        // FileShare.None ensures no other handle may open while we write.
        // Use a stream-creating constructor and then write the contents.
        await using (var stream = new FileStream(
            fullPath,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.None,
            bufferSize: 4096,
            FileOptions.None))
        {
            if (!contents.IsEmpty)
            {
                await stream.WriteAsync(contents, ct).ConfigureAwait(false);
                await stream.FlushAsync(ct).ConfigureAwait(false);
            }
        }

        this.byteLength = contents.Length;

        // INV-3 / INV-6: apply per-platform owner-only permissions.
        if (OperatingSystem.IsLinux() || OperatingSystem.IsMacOS() || OperatingSystem.IsFreeBSD())
        {
            ApplyUnixOwnerOnly(fullPath);
        }
        else if (OperatingSystem.IsWindows())
        {
            ApplyWindowsOwnerOnly(fullPath);
        }

        this.path = new AbsolutePath(fullPath);
        return this.path.Value;
    }

    /// <summary>INV-7: best-effort secure deletion (overwrite then remove).</summary>
    /// <returns>A completed <see cref="ValueTask"/>.</returns>
    public async ValueTask DisposeAsync()
    {
        if (System.Threading.Interlocked.Exchange(ref this.disposed, 1) != 0)
        {
            return;
        }

        if (this.path is not { } p)
        {
            return;
        }

        try
        {
            if (File.Exists(p.Value))
            {
                // Best-effort overwrite with zeros, then delete.
                try
                {
                    await using var fs = new FileStream(
                        p.Value,
                        FileMode.Open,
                        FileAccess.Write,
                        FileShare.None);
                    var len = this.byteLength > 0 ? this.byteLength : fs.Length;
                    if (len > 0)
                    {
                        var buf = new byte[Math.Min(len, 4096)];
                        long remaining = len;
                        while (remaining > 0)
                        {
                            var toWrite = (int)Math.Min(buf.LongLength, remaining);
                            await fs.WriteAsync(buf.AsMemory(0, toWrite)).ConfigureAwait(false);
                            remaining -= toWrite;
                        }

                        await fs.FlushAsync().ConfigureAwait(false);
                    }
                }
                catch (IOException)
                {
                    // best-effort
                }
                catch (UnauthorizedAccessException)
                {
                    // best-effort
                }

                try
                {
                    File.Delete(p.Value);
                }
                catch (IOException)
                {
                    // best-effort
                }
                catch (UnauthorizedAccessException)
                {
                    // best-effort
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // INV-7: best-effort; failure to securely-wipe is not fatal.
        }
    }

    [UnsupportedOSPlatform("windows")]
    [UnsupportedOSPlatform("browser")]
    private static void ApplyUnixOwnerOnly(string fullPath)
    {
        // 0600 — owner read+write only, no execute (INV-3: never set the executable bit)
        File.SetUnixFileMode(
            fullPath,
            UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }

    [SupportedOSPlatform("windows")]
    private static void ApplyWindowsOwnerOnly(string fullPath)
    {
        var fileInfo = new FileInfo(fullPath);
        var security = new FileSecurity();

        // Disable inheritance so only our explicit ACE applies.
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);

        var currentUser = WindowsIdentity.GetCurrent().User
            ?? throw new InvalidOperationException("Could not determine current user SID.");

        // Owner = current user.
        security.SetOwner(currentUser);

        // Single ACE: current user gets Read + ReadAndExecute (INV-3 — no Write/Delete).
        security.AddAccessRule(new FileSystemAccessRule(
            currentUser,
            FileSystemRights.Read | FileSystemRights.ReadAndExecute,
            AccessControlType.Allow));

        fileInfo.SetAccessControl(security);
    }
}
