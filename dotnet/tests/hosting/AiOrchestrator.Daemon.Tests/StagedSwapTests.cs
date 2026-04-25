// <copyright file="StagedSwapTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Daemon.Update;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace AiOrchestrator.Daemon.Tests;

public sealed class StagedSwapTests : IDisposable
{
    private readonly string tmpRoot;

    public StagedSwapTests()
    {
        var repoRoot = FindRepoRoot();
        this.tmpRoot = Path.Combine(repoRoot, ".orchestrator", "tmp", "swap-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.tmpRoot);
    }

    public void Dispose()
    {
        try { Directory.Delete(this.tmpRoot, recursive: true); } catch { }
    }

    [Fact]
    public async Task SwapAsync_MovesInstallToBackupAndStagingToInstall()
    {
        var clock = new FakeClock();
        var swap = new StagedSwap(clock, NullLogger<StagedSwap>.Instance);

        var installRoot = new AbsolutePath(Path.Combine(this.tmpRoot, "install"));
        var stagingRoot = new AbsolutePath(Path.Combine(this.tmpRoot, "staging"));

        Directory.CreateDirectory(installRoot.Value);
        File.WriteAllText(Path.Combine(installRoot.Value, "v1.txt"), "v1");

        Directory.CreateDirectory(stagingRoot.Value);
        File.WriteAllText(Path.Combine(stagingRoot.Value, "v2.txt"), "v2");

        var backup = await swap.SwapAsync(installRoot, stagingRoot, CancellationToken.None);

        Assert.True(Directory.Exists(backup.Value), "backup should exist");
        Assert.True(File.Exists(Path.Combine(installRoot.Value, "v2.txt")), "staging promoted to install");
        Assert.True(File.Exists(Path.Combine(backup.Value, "v1.txt")), "old install backed up");
        Assert.False(Directory.Exists(stagingRoot.Value), "staging dir should be gone");
    }

    [Fact]
    public async Task SwapAsync_NoExistingInstall_JustPromotes()
    {
        var clock = new FakeClock();
        var swap = new StagedSwap(clock, NullLogger<StagedSwap>.Instance);

        var installRoot = new AbsolutePath(Path.Combine(this.tmpRoot, "fresh-install"));
        var stagingRoot = new AbsolutePath(Path.Combine(this.tmpRoot, "staging2"));

        Directory.CreateDirectory(stagingRoot.Value);
        File.WriteAllText(Path.Combine(stagingRoot.Value, "app.bin"), "data");

        var backup = await swap.SwapAsync(installRoot, stagingRoot, CancellationToken.None);

        Assert.True(File.Exists(Path.Combine(installRoot.Value, "app.bin")));
    }

    [Fact]
    public async Task SwapAsync_CancellationRequested_Throws()
    {
        var clock = new FakeClock();
        var swap = new StagedSwap(clock, NullLogger<StagedSwap>.Instance);
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAsync<OperationCanceledException>(() =>
            swap.SwapAsync(
                new AbsolutePath(Path.Combine(this.tmpRoot, "a")),
                new AbsolutePath(Path.Combine(this.tmpRoot, "b")),
                cts.Token).AsTask());
    }

    [Fact]
    public async Task RollbackAsync_RestoresFromBackup()
    {
        var clock = new FakeClock();
        var swap = new StagedSwap(clock, NullLogger<StagedSwap>.Instance);

        var installRoot = new AbsolutePath(Path.Combine(this.tmpRoot, "rb-install"));
        var backupRoot = new AbsolutePath(Path.Combine(this.tmpRoot, "rb-backup"));

        // Simulate a bad install and a backup.
        Directory.CreateDirectory(installRoot.Value);
        File.WriteAllText(Path.Combine(installRoot.Value, "bad.txt"), "bad");

        Directory.CreateDirectory(backupRoot.Value);
        File.WriteAllText(Path.Combine(backupRoot.Value, "good.txt"), "good");

        await swap.RollbackAsync(installRoot, backupRoot, CancellationToken.None);

        Assert.True(File.Exists(Path.Combine(installRoot.Value, "good.txt")));
        Assert.False(Directory.Exists(backupRoot.Value));
    }

    [Fact]
    public async Task RollbackAsync_CancellationRequested_Throws()
    {
        var clock = new FakeClock();
        var swap = new StagedSwap(clock, NullLogger<StagedSwap>.Instance);
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAsync<OperationCanceledException>(() =>
            swap.RollbackAsync(
                new AbsolutePath(Path.Combine(this.tmpRoot, "a")),
                new AbsolutePath(Path.Combine(this.tmpRoot, "b")),
                cts.Token).AsTask());
    }

    [Fact]
    public async Task SwapAsync_StagingMoveFails_RollsBackInstall()
    {
        var clock = new FakeClock();
        var swap = new StagedSwap(clock, NullLogger<StagedSwap>.Instance);

        var installRoot = new AbsolutePath(Path.Combine(this.tmpRoot, "swap-fail-install"));
        var stagingRoot = new AbsolutePath(Path.Combine(this.tmpRoot, "nonexistent-staging"));

        Directory.CreateDirectory(installRoot.Value);
        File.WriteAllText(Path.Combine(installRoot.Value, "marker.txt"), "original");

        // Staging doesn't exist → Directory.Move will throw
        await Assert.ThrowsAsync<DirectoryNotFoundException>(() =>
            swap.SwapAsync(installRoot, stagingRoot, CancellationToken.None).AsTask());

        // The install root should be restored from backup.
        Assert.True(File.Exists(Path.Combine(installRoot.Value, "marker.txt")),
            "Rollback should restore install after staging move failure");
    }

    private static string FindRepoRoot()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null && !File.Exists(Path.Combine(dir, "dotnet", "AiOrchestrator.slnx")))
        {
            dir = Path.GetDirectoryName(dir);
        }

        return dir ?? AppContext.BaseDirectory;
    }
}
