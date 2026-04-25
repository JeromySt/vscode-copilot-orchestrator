// <copyright file="PathValidatorCoverageTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.PathValidator.Paths;
using Xunit;

namespace AiOrchestrator.PathValidator.Tests;

public sealed class PathValidatorCoverageTests : IDisposable
{
    private readonly string tempDir;

    public PathValidatorCoverageTests()
    {
        this.tempDir = Path.Combine(Path.GetTempPath(), "pv-cov-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.tempDir);
    }

    public void Dispose()
    {
        try { Directory.Delete(this.tempDir, recursive: true); } catch { }
    }

    // ─────────── Null guards ───────────

    [Fact]
    public void AssertSafe_NullPath_ThrowsArgumentNull()
    {
        var validator = new DefaultPathValidator(new[] { "/root" });
        Assert.Throws<ArgumentNullException>(() => validator.AssertSafe((string)null!, "/root"));
    }

    [Fact]
    public void AssertSafe_NullAllowedRoot_ThrowsArgumentNull()
    {
        var root = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? @"C:\test" : "/test";
        var validator = new DefaultPathValidator(new[] { root });
        Assert.Throws<ArgumentNullException>(() => validator.AssertSafe(root, (string)null!));
    }

    // ─────────── Reserved names ───────────

    [Theory]
    [InlineData("PRN")]
    [InlineData("AUX")]
    [InlineData("NUL")]
    [InlineData("COM1")]
    [InlineData("COM9")]
    [InlineData("LPT1")]
    [InlineData("LPT9")]
    public void AssertSafe_ReservedDeviceNames_Rejected(string reserved)
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return;
        }

        var validator = new DefaultPathValidator(new[] { @"C:\root" });
        var act = () => validator.AssertSafe($@"C:\root\{reserved}", @"C:\root");
        Assert.Throws<UnauthorizedAccessException>(act);
    }

    [Fact]
    public void AssertSafe_ReservedNameWithStream_Rejected()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return;
        }

        var validator = new DefaultPathValidator(new[] { @"C:\root" });
        // CON:stream should still be caught because we split on ':'
        var act = () => validator.AssertSafe(@"C:\root\CON", @"C:\root");
        Assert.Throws<UnauthorizedAccessException>(act);
    }

    // ─────────── Containment edge cases ───────────

    [Fact]
    public void AssertSafe_PathAtExactRoot_Allowed()
    {
        var root = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? @"C:\root" : "/root";
        var validator = new DefaultPathValidator(new[] { root });
        // Path equals root — should be allowed (it IS the root)
        validator.AssertSafe(root, root);
    }

    [Fact]
    public void AssertSafe_PathPrefixOverlap_Rejected()
    {
        // /root-extra should NOT be accepted when root is /root
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            var validator = new DefaultPathValidator(new[] { @"C:\root" });
            var act = () => validator.AssertSafe(@"C:\root-extra\file.txt", @"C:\root");
            Assert.Throws<UnauthorizedAccessException>(act);
        }
        else
        {
            var validator = new DefaultPathValidator(new[] { "/root" });
            var act = () => validator.AssertSafe("/root-extra/file.txt", "/root");
            Assert.Throws<UnauthorizedAccessException>(act);
        }
    }

    [Fact]
    public void AssertSafe_NestedSubdirectory_Allowed()
    {
        var root = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? @"C:\root" : "/root";
        var path = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? @"C:\root\a\b\c\file.txt" : "/root/a/b/c/file.txt";
        var validator = new DefaultPathValidator(new[] { root });
        validator.AssertSafe(path, root); // should not throw
    }

    // ─────────── AbsolutePath overload ───────────

    [Fact]
    public void AssertSafe_AbsolutePathOverload_ValidPath_NoThrow()
    {
        var root = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? @"C:\root" : "/root";
        var path = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? @"C:\root\file.txt" : "/root/file.txt";
        var validator = new DefaultPathValidator(new[] { root });
        validator.AssertSafe(new AbsolutePath(path), new AbsolutePath(root));
    }

    [Fact]
    public void AssertSafe_AbsolutePathOverload_TraversalPath_Throws()
    {
        var root = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? @"C:\root" : "/root";
        var path = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? @"C:\root\..\outside" : "/root/../outside";
        var validator = new DefaultPathValidator(new[] { root });
        Assert.Throws<UnauthorizedAccessException>(() =>
            validator.AssertSafe(new AbsolutePath(path), new AbsolutePath(root)));
    }

    // ─────────── OpenReadUnderRootAsync ───────────

    [Fact]
    public async System.Threading.Tasks.Task OpenReadUnderRootAsync_StringOverload_NullRoot_Throws()
    {
        var validator = new DefaultPathValidator(new[] { this.tempDir });
        await Assert.ThrowsAsync<ArgumentNullException>(async () =>
            await validator.OpenReadUnderRootAsync((string)null!, "file.txt", CancellationToken.None));
    }

    [Fact]
    public async System.Threading.Tasks.Task OpenReadUnderRootAsync_StringOverload_NullRelative_Throws()
    {
        var validator = new DefaultPathValidator(new[] { this.tempDir });
        await Assert.ThrowsAsync<ArgumentNullException>(async () =>
            await validator.OpenReadUnderRootAsync(this.tempDir, (string)null!, CancellationToken.None));
    }

    [Fact]
    public async System.Threading.Tasks.Task OpenReadUnderRootAsync_StringOverload_ValidFile_ReturnsStream()
    {
        var filePath = Path.Combine(this.tempDir, "readable.txt");
        File.WriteAllText(filePath, "content");

        var validator = new DefaultPathValidator(new[] { this.tempDir });
        using var stream = await validator.OpenReadUnderRootAsync(this.tempDir, "readable.txt", CancellationToken.None);
        Assert.NotNull(stream);
        Assert.True(stream.CanRead);
    }

    [Fact]
    public async System.Threading.Tasks.Task OpenReadUnderRootAsync_StringOverload_Traversal_Throws()
    {
        var validator = new DefaultPathValidator(new[] { this.tempDir });
        await Assert.ThrowsAsync<UnauthorizedAccessException>(async () =>
            await validator.OpenReadUnderRootAsync(this.tempDir, "../../../etc/passwd", CancellationToken.None));
    }

    [Fact]
    public async System.Threading.Tasks.Task OpenReadUnderRootAsync_AbsolutePathOverload_ValidFile_ReturnsStream()
    {
        var filePath = Path.Combine(this.tempDir, "model-read.txt");
        File.WriteAllText(filePath, "data");

        var validator = new DefaultPathValidator(new[] { this.tempDir });
        var root = new AbsolutePath(this.tempDir);
        var relative = new RelativePath("model-read.txt");
        using var stream = await validator.OpenReadUnderRootAsync(root, relative, CancellationToken.None);
        Assert.NotNull(stream);
        Assert.True(stream.CanRead);
    }

    // ─────────── Constructor ───────────

    [Fact]
    public void Constructor_NullAllowedRoots_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => new DefaultPathValidator(null!));
    }
}
