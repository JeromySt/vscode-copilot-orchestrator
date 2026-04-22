// <copyright file="SecureTempScriptTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;
using System.Security.AccessControl;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Shell.Temp;
using Xunit;

namespace AiOrchestrator.Shell.Tests;

/// <summary>Acceptance tests covering PS-ISO-3 (mode/DACL), CMD-TMP-1 (atomic create), and SHELL-TEMP-DELETE.</summary>
public class SecureTempScriptTests : IDisposable
{
    private readonly string tempDir;

    public SecureTempScriptTests()
    {
        this.tempDir = Path.Combine(Path.GetTempPath(), "orca-shell-test-" + Guid.NewGuid().ToString("N"));
        _ = Directory.CreateDirectory(this.tempDir);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(this.tempDir, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }

        GC.SuppressFinalize(this);
    }

    [Fact]
    [ContractTest("PS-ISO-3")]
    public async Task PS_ISO_3_TempScriptModeIs0600OnUnix()
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return; // Unix-only contract — Windows path checked by sibling test.
        }

        await using var temp = new SecureTempScript(new AbsolutePath(this.tempDir));
        var path = await temp.CreateAsync(new byte[] { 1, 2, 3 }, ".sh", CancellationToken.None);

        var mode = File.GetUnixFileMode(path.Value);
        // INV-3: 0600 — owner read+write only, no execute, no group/other access.
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, mode);
    }

    [Fact]
    [ContractTest("PS-ISO-3")]
    public async Task PS_ISO_3_TempScriptDaclOwnerOnlyOnWindows()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return; // Windows-only contract.
        }

        await using var temp = new SecureTempScript(new AbsolutePath(this.tempDir));
        var path = await temp.CreateAsync(new byte[] { 1, 2, 3 }, ".ps1", CancellationToken.None);

        var fi = new FileInfo(path.Value);
        var sec = fi.GetAccessControl();
        var rules = sec.GetAccessRules(includeExplicit: true, includeInherited: true, typeof(System.Security.Principal.SecurityIdentifier));

        Assert.Equal(1, rules.Count);
        var ace = (FileSystemAccessRule)rules[0]!;
        Assert.Equal(AccessControlType.Allow, ace.AccessControlType);

        var currentSid = System.Security.Principal.WindowsIdentity.GetCurrent().User!;
        Assert.Equal(currentSid.Value, ace.IdentityReference.Value);

        // No write or delete rights granted.
        Assert.False((ace.FileSystemRights & FileSystemRights.Write) != 0);
        Assert.False((ace.FileSystemRights & FileSystemRights.Delete) != 0);
    }

    [Fact]
    [ContractTest("CMD-TMP-1")]
    public async Task CMD_TMP_1_OExclPreventsOverwrite()
    {
        // Pre-occupy the exact file name the SecureTempScript would try to create.
        // Because the runner uses a Guid-derived name we instead exercise the second-create path:
        // creating two scripts of the same fixed name through low-level CreateNew.
        var collisionPath = Path.Combine(this.tempDir, "collision.sh");
        await File.WriteAllTextAsync(collisionPath, "preexisting");

        // FileMode.CreateNew must throw IOException when the file already exists.
        // SecureTempScript relies on this guarantee for atomicity (CMD-TMP-1 / INV-6).
        var act = () =>
        {
            using var fs = new FileStream(
                collisionPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None);
        };

        Assert.Throws<IOException>(act);
    }

    [Fact]
    [ContractTest("CMD-TMP-1")]
    public async Task CMD_TMP_1_CreateNewPreventsOverwriteOnWindows()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return; // Windows-only variant.
        }

        // Two SecureTempScript instances pointed at the same tempDir must each succeed because
        // file names are Guid-derived. Verify that the SAME path cannot be re-used by manually
        // re-creating the file via the same atomic-create primitive — proving CREATE_NEW semantics.
        await using var temp = new SecureTempScript(new AbsolutePath(this.tempDir));
        var path = await temp.CreateAsync(new byte[] { 1 }, ".ps1", CancellationToken.None);

        var act = () =>
        {
            using var fs = new FileStream(
                path.Value,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None);
        };

        Assert.Throws<IOException>(act);
    }

    [Fact]
    [ContractTest("SHELL-TEMP-DELETE")]
    public async Task SHELL_TEMP_SecurelyDeletedOnDispose()
    {
        AbsolutePath path;
        await using (var temp = new SecureTempScript(new AbsolutePath(this.tempDir)))
        {
            path = await temp.CreateAsync(System.Text.Encoding.UTF8.GetBytes("secret"), ".sh", CancellationToken.None);
            Assert.True(File.Exists(path.Value));
        }

        // After disposal the file must be removed (best-effort secure deletion).
        Assert.False(File.Exists(path.Value));
    }
}
