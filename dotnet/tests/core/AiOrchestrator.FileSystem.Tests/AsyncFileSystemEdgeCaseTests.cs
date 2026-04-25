// <copyright file="AsyncFileSystemEdgeCaseTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.FileSystem.Mount;
using AiOrchestrator.FileSystem.Native.Linux;
using AiOrchestrator.FileSystem.Native.Windows;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.PathValidator.Paths;
using Xunit;

namespace AiOrchestrator.FileSystem.Tests;

/// <summary>Edge case and gap-filling tests for <see cref="AsyncFileSystem"/>.</summary>
public sealed class AsyncFileSystemEdgeCaseTests
{
    private static AsyncFileSystem MakeFileSystem(string root)
    {
        IMountInspector mounts = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? new WindowsMountInspector()
            : new LinuxMountInspector();
        var validator = new DefaultPathValidator(new[] { root });
        return new AsyncFileSystem(validator, mounts);
    }

    [Fact]
    public async Task ReadAllTextAsync_NonExistentFile_ThrowsFileNotFound()
    {
        using var temp = new TempDir();
        var fs = MakeFileSystem(temp.Path);
        var missing = new AbsolutePath(temp.Combine("does-not-exist.txt"));

        await Assert.ThrowsAsync<FileNotFoundException>(
            () => fs.ReadAllTextAsync(missing, default).AsTask());
    }

    [Fact]
    public async Task WriteAndReadAllTextAsync_PreservesUnicode()
    {
        using var temp = new TempDir();
        var fs = MakeFileSystem(temp.Path);
        var path = new AbsolutePath(temp.Combine("unicode.txt"));
        const string Content = "Hello 世界 🌍 café";

        await fs.WriteAllTextAsync(path, Content, default);
        var result = await fs.ReadAllTextAsync(path, default);

        Assert.Equal(Content, result);
    }

    [Fact]
    public async Task ExistsAsync_ReturnsTrueForDirectory()
    {
        using var temp = new TempDir();
        var fs = MakeFileSystem(temp.Path);
        var subdir = new AbsolutePath(temp.Combine("subdir"));
        Directory.CreateDirectory(subdir.Value);

        Assert.True(await fs.ExistsAsync(subdir, default));
    }

    [Fact]
    public async Task ExistsAsync_ReturnsFalseForNonexistent()
    {
        using var temp = new TempDir();
        var fs = MakeFileSystem(temp.Path);
        var missing = new AbsolutePath(temp.Combine("nope"));

        Assert.False(await fs.ExistsAsync(missing, default));
    }

    [Fact]
    public async Task MoveAtomicAsync_OverwritesExistingDestination()
    {
        using var temp = new TempDir();
        var fs = MakeFileSystem(temp.Path);
        var src = new AbsolutePath(temp.Combine("src.txt"));
        var dst = new AbsolutePath(temp.Combine("dst.txt"));

        await fs.WriteAllTextAsync(src, "new-data", default);
        await fs.WriteAllTextAsync(dst, "old-data", default);
        await fs.MoveAtomicAsync(src, dst, default);

        Assert.Equal("new-data", await fs.ReadAllTextAsync(dst, default));
        Assert.False(await fs.ExistsAsync(src, default));
    }

    [Fact]
    public async Task DeleteAsync_NonexistentPath_IsNoOp()
    {
        using var temp = new TempDir();
        var fs = MakeFileSystem(temp.Path);
        var missing = new AbsolutePath(temp.Combine("ghost.txt"));

        // Should not throw.
        await fs.DeleteAsync(missing, default);
    }

    [Fact]
    public async Task WriteAllTextAsync_CreatesFileIfNotExists()
    {
        using var temp = new TempDir();
        var fs = MakeFileSystem(temp.Path);
        var path = new AbsolutePath(temp.Combine("brand-new.txt"));

        await fs.WriteAllTextAsync(path, "content", default);

        Assert.True(File.Exists(path.Value));
        Assert.Equal("content", await fs.ReadAllTextAsync(path, default));
    }

    [Fact]
    public async Task WriteAllTextAsync_OverwritesExisting()
    {
        using var temp = new TempDir();
        var fs = MakeFileSystem(temp.Path);
        var path = new AbsolutePath(temp.Combine("overwrite.txt"));

        await fs.WriteAllTextAsync(path, "first", default);
        await fs.WriteAllTextAsync(path, "second", default);

        Assert.Equal("second", await fs.ReadAllTextAsync(path, default));
    }

    [Fact]
    public void Ctor_NullValidator_Throws()
    {
        IMountInspector mounts = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? new WindowsMountInspector()
            : new LinuxMountInspector();

        Assert.Throws<ArgumentNullException>(() => new AsyncFileSystem(null!, mounts));
    }

    [Fact]
    public void Ctor_NullMounts_Throws()
    {
        using var temp = new TempDir();
        var validator = new DefaultPathValidator(new[] { temp.Path });

        Assert.Throws<ArgumentNullException>(() => new AsyncFileSystem(validator, null!));
    }

    [Fact]
    public async Task ExistsAsync_CancellationRequested_Throws()
    {
        using var temp = new TempDir();
        var fs = MakeFileSystem(temp.Path);
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => fs.ExistsAsync(new AbsolutePath(temp.Path), cts.Token).AsTask());
    }
}
