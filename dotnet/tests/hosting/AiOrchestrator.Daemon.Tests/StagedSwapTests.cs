// <copyright file="StagedSwapTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Daemon.Update;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace AiOrchestrator.Daemon.Tests;

public sealed class StagedSwapTests
{
    [Fact]
    public async Task SwapAsync_MovesInstallToBackupAndStagingToInstall()
    {
        var fs = new InMemoryFileSystem();
        var clock = new FakeClock();
        var swap = new StagedSwap(fs, clock, NullLogger<StagedSwap>.Instance);

        var installRoot = new AbsolutePath("/test/install");
        var stagingRoot = new AbsolutePath("/test/staging");

        fs.Directories.Add(installRoot.Value);
        fs.Files[Path.Combine(installRoot.Value, "v1.txt")] = Encoding.UTF8.GetBytes("v1");

        fs.Directories.Add(stagingRoot.Value);
        fs.Files[Path.Combine(stagingRoot.Value, "v2.txt")] = Encoding.UTF8.GetBytes("v2");

        var backup = await swap.SwapAsync(installRoot, stagingRoot, CancellationToken.None);

        Assert.True(fs.Directories.Contains(backup.Value), "backup should exist");
        Assert.True(fs.Files.ContainsKey(Path.Combine(installRoot.Value, "v2.txt")), "staging promoted to install");
        Assert.True(fs.Files.ContainsKey(Path.Combine(backup.Value, "v1.txt")), "old install backed up");
        Assert.False(fs.Directories.Contains(stagingRoot.Value), "staging dir should be gone");
    }

    [Fact]
    public async Task SwapAsync_NoExistingInstall_JustPromotes()
    {
        var fs = new InMemoryFileSystem();
        var clock = new FakeClock();
        var swap = new StagedSwap(fs, clock, NullLogger<StagedSwap>.Instance);

        var installRoot = new AbsolutePath("/test/fresh-install");
        var stagingRoot = new AbsolutePath("/test/staging2");

        fs.Directories.Add(stagingRoot.Value);
        fs.Files[Path.Combine(stagingRoot.Value, "app.bin")] = Encoding.UTF8.GetBytes("data");

        var backup = await swap.SwapAsync(installRoot, stagingRoot, CancellationToken.None);

        Assert.True(fs.Files.ContainsKey(Path.Combine(installRoot.Value, "app.bin")));
    }

    [Fact]
    public async Task SwapAsync_CancellationRequested_Throws()
    {
        var fs = new InMemoryFileSystem();
        var clock = new FakeClock();
        var swap = new StagedSwap(fs, clock, NullLogger<StagedSwap>.Instance);
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAsync<OperationCanceledException>(() =>
            swap.SwapAsync(
                new AbsolutePath("/test/a"),
                new AbsolutePath("/test/b"),
                cts.Token).AsTask());
    }

    [Fact]
    public async Task RollbackAsync_RestoresFromBackup()
    {
        var fs = new InMemoryFileSystem();
        var clock = new FakeClock();
        var swap = new StagedSwap(fs, clock, NullLogger<StagedSwap>.Instance);

        var installRoot = new AbsolutePath("/test/rb-install");
        var backupRoot = new AbsolutePath("/test/rb-backup");

        // Simulate a bad install and a backup.
        fs.Directories.Add(installRoot.Value);
        fs.Files[Path.Combine(installRoot.Value, "bad.txt")] = Encoding.UTF8.GetBytes("bad");

        fs.Directories.Add(backupRoot.Value);
        fs.Files[Path.Combine(backupRoot.Value, "good.txt")] = Encoding.UTF8.GetBytes("good");

        await swap.RollbackAsync(installRoot, backupRoot, CancellationToken.None);

        Assert.True(fs.Files.ContainsKey(Path.Combine(installRoot.Value, "good.txt")));
        Assert.False(fs.Directories.Contains(backupRoot.Value));
    }

    [Fact]
    public async Task RollbackAsync_CancellationRequested_Throws()
    {
        var fs = new InMemoryFileSystem();
        var clock = new FakeClock();
        var swap = new StagedSwap(fs, clock, NullLogger<StagedSwap>.Instance);
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAsync<OperationCanceledException>(() =>
            swap.RollbackAsync(
                new AbsolutePath("/test/a"),
                new AbsolutePath("/test/b"),
                cts.Token).AsTask());
    }

    [Fact]
    public async Task SwapAsync_StagingMoveFails_RollsBackInstall()
    {
        var fs = new InMemoryFileSystem();
        var clock = new FakeClock();
        var swap = new StagedSwap(fs, clock, NullLogger<StagedSwap>.Instance);

        var installRoot = new AbsolutePath("/test/swap-fail-install");
        var stagingRoot = new AbsolutePath("/test/nonexistent-staging");

        fs.Directories.Add(installRoot.Value);
        fs.Files[Path.Combine(installRoot.Value, "marker.txt")] = Encoding.UTF8.GetBytes("original");

        // Staging doesn't exist → MoveAtomicAsync will throw DirectoryNotFoundException
        await Assert.ThrowsAsync<DirectoryNotFoundException>(() =>
            swap.SwapAsync(installRoot, stagingRoot, CancellationToken.None).AsTask());

        // The install root should be restored from backup.
        Assert.True(fs.Files.ContainsKey(Path.Combine(installRoot.Value, "marker.txt")),
            "Rollback should restore install after staging move failure");
    }
}
