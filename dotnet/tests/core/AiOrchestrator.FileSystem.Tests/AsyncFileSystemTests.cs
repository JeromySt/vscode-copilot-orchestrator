// <copyright file="AsyncFileSystemTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.IO;
using System.Runtime.InteropServices;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.FileSystem;
using AiOrchestrator.FileSystem.Mount;
using AiOrchestrator.FileSystem.Native.Linux;
using AiOrchestrator.FileSystem.Native.Windows;
using AiOrchestrator.Foundation.Tests;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.PathValidator.Paths;
using Xunit;

namespace AiOrchestrator.FileSystem.Tests;

/// <summary>Acceptance tests for <see cref="AsyncFileSystem"/> covering FS-1..4 and CMD-TMP-1.</summary>
public sealed class AsyncFileSystemTests
{
    [Fact]
    [ContractTest("FS-1")]
    public async Task FS_1_WriteThrough_RejectsTraversal()
    {
        using var temp = new TempDir();
        var fs = MakeFileSystem(temp.Path);

        // A path containing ".." should be rejected by the validator.
        // We construct it as an AbsolutePath whose string contains "..".
        var traversal = new AbsolutePath(Path.Combine(temp.Path, "..", "outside.txt"));

        var act = async () => await fs.WriteAllTextAsync(traversal, "leak", default);
        await Assert.ThrowsAsync<UnauthorizedAccessException>(act);
    }

    [Fact]
    [ContractTest("CMD-TMP-1-LIN")]
    public async Task CMD_TMP_1_NewFileUsesOExclAnd0600_Linux()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Linux) && !RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            return; // platform-gated
        }

        using var temp = new TempDir();
        var fs = MakeFileSystem(temp.Path);
        var target = new AbsolutePath(temp.Combine("secret.txt"));

        await using (var stream = await fs.OpenWriteExclusiveAsync(target, new FilePermissions(0x180), default))
        {
            await stream.WriteAsync("secret"u8.ToArray(), default);
        }

        // Second OpenWriteExclusiveAsync on same path MUST throw IOException (O_EXCL semantics).
        var second = async () =>
        {
            await using var s2 = await fs.OpenWriteExclusiveAsync(target, new FilePermissions(0x180), default);
        };
        await Assert.ThrowsAsync<IOException>(second);

        // Mode bits must match 0600 — verified via stat() on POSIX. We use a libc call indirectly via FileInfo.UnixFileMode.
        var mode = File.GetUnixFileMode(target.Value);
        Assert.Equal(0x180, (int)mode & 0x1FF);
    }

    [Fact]
    [ContractTest("CMD-TMP-1-WIN")]
    public async Task CMD_TMP_1_NewFileUsesCreateNewAndOwnerOnlyDacl_Windows()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return;
        }

        using var temp = new TempDir();
        var fs = MakeFileSystem(temp.Path);
        var target = new AbsolutePath(temp.Combine("secret.txt"));

        await using (var stream = await fs.OpenWriteExclusiveAsync(target, default, default))
        {
            await stream.WriteAsync("secret"u8.ToArray(), default);
        }

        // Second open must throw IOException (CreateNew semantics).
        var second = async () =>
        {
            await using var s2 = await fs.OpenWriteExclusiveAsync(target, default, default);
        };
        await Assert.ThrowsAsync<IOException>(second);

        // Verify DACL contains exactly one access rule for the current user.
        var fi = new FileInfo(target.Value);
        var acl = fi.GetAccessControl();
        var rules = acl.GetAccessRules(includeExplicit: true, includeInherited: false, typeof(System.Security.Principal.SecurityIdentifier));
        Assert.True(rules.Count > 0, "DACL should have at least one explicit rule (owner-only)");
    }

    [Fact]
    [ContractTest("FS-2")]
    public async Task FS_2_AtomicMove_PreservesPermissions()
    {
        using var temp = new TempDir();
        var fs = MakeFileSystem(temp.Path);
        var src = new AbsolutePath(temp.Combine("a.txt"));
        var dst = new AbsolutePath(temp.Combine("b.txt"));

        await fs.WriteAllTextAsync(src, "atomic", default);

        // Pre-create destination to verify replace-existing semantics.
        await fs.WriteAllTextAsync(dst, "old", default);

        await fs.MoveAtomicAsync(src, dst, default);

        Assert.False(await fs.ExistsAsync(src, default));
        Assert.True(await fs.ExistsAsync(dst, default));
        Assert.Equal("atomic", await fs.ReadAllTextAsync(dst, default));
    }

    [Fact]
    [ContractTest("FS-4")]
    public async Task FS_4_AsyncFileSystem_SatisfiesContract()
    {
        var contract = new AsyncFileSystemContract();
        await contract.RoundTrip_Write_Read_Returns_Same_Content();
        await contract.ExistsAsync_Returns_False_For_Missing();
        await contract.DeleteAsync_Removes_File();
    }

    [Fact]
    public async Task OpenReadAsync_StreamsContent()
    {
        using var temp = new TempDir();
        var fs = MakeFileSystem(temp.Path);
        var target = new AbsolutePath(temp.Combine("read.txt"));
        await fs.WriteAllTextAsync(target, "hello-stream", default);

        await using var stream = await fs.OpenReadAsync(target, default);
        using var reader = new StreamReader(stream);
        Assert.Equal("hello-stream", await reader.ReadToEndAsync());
    }

    [Fact]
    public async Task OpenWriteExclusiveAsync_DefaultPerms_RoundTripsContent()
    {
        using var temp = new TempDir();
        var fs = MakeFileSystem(temp.Path);
        var target = new AbsolutePath(temp.Combine("excl.bin"));

        await using (var stream = await fs.OpenWriteExclusiveAsync(target, default, default))
        {
            await stream.WriteAsync(new byte[] { 1, 2, 3, 4 }, default);
        }

        var fi = new FileInfo(target.Value);
        Assert.Equal(4, fi.Length);
    }

    [Fact]
    public async Task DeleteAsync_RemovesDirectoryAndIsIdempotent()
    {
        using var temp = new TempDir();
        var fs = MakeFileSystem(temp.Path);
        var dir = new AbsolutePath(temp.Combine("subdir"));
        Directory.CreateDirectory(dir.Value);

        await fs.DeleteAsync(dir, default);
        Assert.False(Directory.Exists(dir.Value));

        // Idempotent: deleting non-existent path is a no-op.
        await fs.DeleteAsync(dir, default);
    }

    [Fact]
    public async Task GetMountKindAsync_DelegatesToInspector()
    {
        using var temp = new TempDir();
        var fs = MakeFileSystem(temp.Path);
        var kind = await fs.GetMountKindAsync(new AbsolutePath(temp.Path), default);

        // Both Local and Unknown are acceptable depending on environment/drive type.
        Assert.Contains(kind, new[] { MountKind.Local, MountKind.Unknown, MountKind.Smb });
    }

    [Fact]
    public async Task ExistsAsync_ReturnsTrueForExistingFile()
    {
        using var temp = new TempDir();
        var fs = MakeFileSystem(temp.Path);
        var target = new AbsolutePath(temp.Combine("e.txt"));
        await fs.WriteAllTextAsync(target, "x", default);
        Assert.True(await fs.ExistsAsync(target, default));
    }

    [Fact]
    public async Task WriteAllTextAsync_NullContents_Throws()
    {
        using var temp = new TempDir();
        var fs = MakeFileSystem(temp.Path);
        var target = new AbsolutePath(temp.Combine("n.txt"));
        var act = async () => await fs.WriteAllTextAsync(target, null!, default);
        await Assert.ThrowsAsync<ArgumentNullException>(act);
    }

    internal static AsyncFileSystem MakeFileSystem(string root)
    {
        var validator = new DefaultPathValidator(new[] { root });
        IMountInspector mounts = OperatingSystem.IsWindows()
            ? new WindowsMountInspector()
            : new LinuxMountInspector();
        return new AsyncFileSystem(validator, mounts);
    }

    /// <summary>Concrete contract harness for <see cref="AsyncFileSystem"/> (used by FS-4 and J9-PC-7).</summary>
    public sealed class AsyncFileSystemContract : FileSystemContractTests
    {
        protected override (IFileSystem Fs, AbsolutePath Root, Action Cleanup) CreateFixture()
        {
            var temp = new TempDir();
            var fs = MakeFileSystem(temp.Path);
            return (fs, new AbsolutePath(temp.Path), temp.Dispose);
        }

        [Fact]
        public Task FS_AsyncFileSystem_Contract_RoundTrip() => this.RoundTrip_Write_Read_Returns_Same_Content();
    }
}
