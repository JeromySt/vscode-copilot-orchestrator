// <copyright file="HookGateCoverageGapTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.HookGate.Immutability;
using AiOrchestrator.HookGate.Redirection;
using AiOrchestrator.HookGate.Rpc;
using AiOrchestrator.HookGate.Validation;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.TestKit.Time;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace AiOrchestrator.HookGate.Tests;

/// <summary>Tests targeting uncovered branches in HookGate subsystems.</summary>
public sealed class HookGateCoverageGapTests : IDisposable
{
    private readonly List<string> tempDirs = new();

    public void Dispose()
    {
        foreach (var d in this.tempDirs)
        {
            try { Directory.Delete(d, true); } catch { }
        }
    }

    private string MakeTempDir()
    {
        var d = Path.Combine(Path.GetTempPath(), "hg-gap-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(d);
        this.tempDirs.Add(d);
        return d;
    }

    // ================================================================
    // ImmutabilityProbe â€” Windows DACL path + Classify branches
    // ================================================================

    [Fact]
    public async Task ImmutabilityProbe_Windows_ExitCode0_ReportsSupported()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;

        var spawner = new NullProcessSpawner { ExitCodeForNextSpawn = 0 };
        var clock = new InMemoryClock();
        var probe = new ImmutabilityProbe(clock, spawner);

        var result = await probe.ProbeAsync(new AbsolutePath(Path.GetTempPath()), CancellationToken.None);

        Assert.True(result.Supported);
        Assert.Equal("DACL-deny", result.Mechanism);
        Assert.Null(result.FailureReason);
    }

    [Fact]
    public async Task ImmutabilityProbe_Windows_ExitCodeMinus1_ReportsToolUnavailable()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;

        var spawner = new NullProcessSpawner { ExitCodeForNextSpawn = -1 };
        var clock = new InMemoryClock();
        var probe = new ImmutabilityProbe(clock, spawner);

        var result = await probe.ProbeAsync(new AbsolutePath(Path.GetTempPath()), CancellationToken.None);

        Assert.False(result.Supported);
        Assert.Equal("DACL-deny", result.Mechanism);
        Assert.Equal("tool unavailable", result.FailureReason);
    }

    [Fact]
    public async Task ImmutabilityProbe_Windows_NonZeroExitCode_ReportsExitCode()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;

        var spawner = new NullProcessSpawner { ExitCodeForNextSpawn = 42 };
        var clock = new InMemoryClock();
        var probe = new ImmutabilityProbe(clock, spawner);

        var result = await probe.ProbeAsync(new AbsolutePath(Path.GetTempPath()), CancellationToken.None);

        Assert.False(result.Supported);
        Assert.Contains("exit 42", result.FailureReason);
    }

    [Fact]
    public void ImmutabilityProbe_IsImmutabilitySupported_NullResult_ReturnsFalse()
    {
        var clock = new InMemoryClock();
        var spawner = new NullProcessSpawner();
        var probe = new ImmutabilityProbe(clock, spawner);

        Assert.False(probe.IsImmutabilitySupported(null!));
    }

    [Fact]
    public void ImmutabilityProbe_BuildEvent_NullResult_UsesDefaults()
    {
        var clock = new InMemoryClock();
        var spawner = new NullProcessSpawner();
        var probe = new ImmutabilityProbe(clock, spawner);

        var evt = probe.BuildEvent(new AbsolutePath("/tmp/test"), null!);

        Assert.Equal("unknown", evt.Mechanism);
        Assert.Equal("unsupported", evt.Reason);
    }

    [Fact]
    public void ImmutabilityProbe_Constructor_RejectsNulls()
    {
        var clock = new InMemoryClock();
        var spawner = new NullProcessSpawner();
        Assert.Throws<ArgumentNullException>(() => new ImmutabilityProbe(null!, spawner));
        Assert.Throws<ArgumentNullException>(() => new ImmutabilityProbe(clock, null!));
    }

    [Fact]
    public async Task ImmutabilityProbe_Cancellation_Throws()
    {
        var clock = new InMemoryClock();
        var spawner = new NullProcessSpawner();
        var probe = new ImmutabilityProbe(clock, spawner);
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => probe.ProbeAsync(new AbsolutePath("/test"), cts.Token).AsTask());
    }

    // ================================================================
    // LinkValidator â€” Windows path validation
    // ================================================================

    [Fact]
    public async Task LinkValidator_FileDoesNotExist_ReturnsFailure()
    {
        var validator = new LinkValidator(new PassthroughFileSystem());
        var result = await validator.ValidateAsync(
            new AbsolutePath(Path.Combine(Path.GetTempPath(), "nonexistent-" + Guid.NewGuid())),
            new AbsolutePath(Path.GetTempPath()),
            CancellationToken.None);

        Assert.False(result.Ok);
        Assert.Equal("hook file does not exist", result.FailureReason);
    }

    [Fact]
    public async Task LinkValidator_Windows_NormalFile_InsideWorktree_ReturnsOk()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;

        var dir = MakeTempDir();
        var hookFile = Path.Combine(dir, "pre-commit");
        File.WriteAllText(hookFile, "#!/bin/sh\nexit 0\n");

        var validator = new LinkValidator(new PassthroughFileSystem());
        var result = await validator.ValidateAsync(
            new AbsolutePath(hookFile),
            new AbsolutePath(dir),
            CancellationToken.None);

        Assert.True(result.Ok);
        Assert.Null(result.FailureReason);
    }

    [Fact]
    public async Task LinkValidator_Cancellation_Throws()
    {
        var validator = new LinkValidator(new PassthroughFileSystem());
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => validator.ValidateAsync(
                new AbsolutePath("/test"),
                new AbsolutePath("/root"),
                cts.Token).AsTask());
    }

    // ================================================================
    // WindowsRedirectionManager â€” Uninstall + GetActiveMode branches
    // ================================================================

    [Fact]
    public async Task WindowsRedirectionManager_Uninstall_WhenNothingExists_NoThrow()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;

        var sink = new InMemoryImmutabilitySink();
        var spawner = new NullProcessSpawner();
        var mgr = new WindowsRedirectionManager(sink, spawner, new PassthroughFileSystem(), NullLogger<WindowsRedirectionManager>.Instance);

        var fakePath = Path.Combine(Path.GetTempPath(), "nonexistent-" + Guid.NewGuid().ToString("N"));
        await mgr.UninstallRedirectionAsync(new AbsolutePath(fakePath), CancellationToken.None);
        // No exception = success
    }

    [Fact]
    public async Task WindowsRedirectionManager_Uninstall_WhenDirExists_DeletesIt()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;

        var sink = new InMemoryImmutabilitySink();
        var spawner = new NullProcessSpawner();
        var mgr = new WindowsRedirectionManager(sink, spawner, new PassthroughFileSystem(), NullLogger<WindowsRedirectionManager>.Instance);

        var dir = MakeTempDir();
        var subDir = Path.Combine(dir, "hooks");
        Directory.CreateDirectory(subDir);

        await mgr.UninstallRedirectionAsync(new AbsolutePath(subDir), CancellationToken.None);

        Assert.False(Directory.Exists(subDir));
    }

    [Fact]
    public async Task WindowsRedirectionManager_Uninstall_WhenFileExists_DeletesIt()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;

        var sink = new InMemoryImmutabilitySink();
        var spawner = new NullProcessSpawner();
        var mgr = new WindowsRedirectionManager(sink, spawner, new PassthroughFileSystem(), NullLogger<WindowsRedirectionManager>.Instance);

        var dir = MakeTempDir();
        var filePath = Path.Combine(dir, "hooks");
        File.WriteAllText(filePath, "test");

        await mgr.UninstallRedirectionAsync(new AbsolutePath(filePath), CancellationToken.None);

        Assert.False(File.Exists(filePath));
    }

    [Fact]
    public async Task WindowsRedirectionManager_GetActiveMode_WhenNothingExists_ReturnsNotInstalled()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;

        var sink = new InMemoryImmutabilitySink();
        var spawner = new NullProcessSpawner();
        var mgr = new WindowsRedirectionManager(sink, spawner, new PassthroughFileSystem(), NullLogger<WindowsRedirectionManager>.Instance);

        var mode = await mgr.GetActiveModeAsync(
            new AbsolutePath(Path.Combine(Path.GetTempPath(), "nonexistent-" + Guid.NewGuid())),
            CancellationToken.None);

        Assert.Equal(RedirectionMode.NotInstalled, mode);
    }

    [Fact]
    public async Task WindowsRedirectionManager_GetActiveMode_NonReparseDir_ReturnsNotInstalled()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;

        var sink = new InMemoryImmutabilitySink();
        var spawner = new NullProcessSpawner();
        var mgr = new WindowsRedirectionManager(sink, spawner, new PassthroughFileSystem(), NullLogger<WindowsRedirectionManager>.Instance);

        var dir = MakeTempDir();
        var mode = await mgr.GetActiveModeAsync(new AbsolutePath(dir), CancellationToken.None);

        Assert.Equal(RedirectionMode.NotInstalled, mode);
    }

    [Fact]
    public async Task WindowsRedirectionManager_Install_JunctionFails_FallsBackToSymlink()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;

        var sink = new InMemoryImmutabilitySink();
        var spawner = new NullProcessSpawner { ExitCodeForNextSpawn = 1 }; // mklink /J fails
        var mgr = new WindowsRedirectionManager(sink, spawner, new PassthroughFileSystem(), NullLogger<WindowsRedirectionManager>.Instance);

        var dir = MakeTempDir();
        var hooksDir = Path.Combine(dir, "hooks-" + Guid.NewGuid().ToString("N"));
        var target = Path.Combine(dir, "target-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(target);

        try
        {
            await mgr.InstallRedirectionAsync(
                new AbsolutePath(hooksDir),
                new AbsolutePath(target),
                CancellationToken.None);

            // If symlink creation succeeded (Developer Mode), an immutability event should have been published
            Assert.Single(sink.Events);
            Assert.Contains("symlink", sink.Events[0].Mechanism);
        }
        catch (IOException)
        {
            // Symlink creation failed (no Developer Mode) â€” expected on non-dev machines
        }
    }

    [Fact]
    public void WindowsRedirectionManager_Constructor_RejectsNulls()
    {
        var sink = new InMemoryImmutabilitySink();
        var spawner = new NullProcessSpawner();
        var logger = NullLogger<WindowsRedirectionManager>.Instance;

        Assert.Throws<ArgumentNullException>(() => new WindowsRedirectionManager(null!, spawner, new PassthroughFileSystem(), logger));
        Assert.Throws<ArgumentNullException>(() => new WindowsRedirectionManager(sink, null!, new PassthroughFileSystem(), logger));
        Assert.Throws<ArgumentNullException>(() => new WindowsRedirectionManager(sink, spawner, new PassthroughFileSystem(), null!));
    }

    [Fact]
    public async Task WindowsRedirectionManager_Install_Cancellation_Throws()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;

        var sink = new InMemoryImmutabilitySink();
        var spawner = new NullProcessSpawner();
        var mgr = new WindowsRedirectionManager(sink, spawner, new PassthroughFileSystem(), NullLogger<WindowsRedirectionManager>.Instance);
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => mgr.InstallRedirectionAsync(
                new AbsolutePath("/test"),
                new AbsolutePath("/target"),
                cts.Token).AsTask());
    }

    // ================================================================
    // NamedPipeRpcServer â€” lifecycle + null guards
    // ================================================================

    [Fact]
    public void NamedPipeRpcServer_Constructor_RejectsNulls()
    {
        Assert.Throws<ArgumentNullException>(() => new NamedPipeRpcServer(null!, NullLogger<NamedPipeRpcServer>.Instance));
        Assert.Throws<ArgumentNullException>(() => new NamedPipeRpcServer("pipe", null!));
    }

    [Fact]
    public void NamedPipeRpcServer_PeerCredChecksPerformed_StartsAtZero()
    {
        var server = new NamedPipeRpcServer("test-pipe", NullLogger<NamedPipeRpcServer>.Instance);
        Assert.Equal(0, server.PeerCredChecksPerformed);
    }

    [Fact]
    public async Task NamedPipeRpcServer_StartAsync_NullHandler_Throws()
    {
        var server = new NamedPipeRpcServer("test-pipe", NullLogger<NamedPipeRpcServer>.Instance);
        await Assert.ThrowsAsync<ArgumentNullException>(
            () => server.StartAsync(null!, CancellationToken.None).AsTask());
        await server.DisposeAsync();
    }

    [Fact]
    public async Task NamedPipeRpcServer_DisposeAsync_IsIdempotent()
    {
        var server = new NamedPipeRpcServer("test-pipe-" + Guid.NewGuid().ToString("N"), NullLogger<NamedPipeRpcServer>.Instance);
        await server.DisposeAsync();
        await server.DisposeAsync(); // second dispose is a no-op
    }

    [Fact]
    public async Task NamedPipeRpcServer_StopAsync_BeforeStart_DoesNotThrow()
    {
        var server = new NamedPipeRpcServer("test-pipe-" + Guid.NewGuid().ToString("N"), NullLogger<NamedPipeRpcServer>.Instance);
        await server.StopAsync(CancellationToken.None);
        await server.DisposeAsync();
    }

    [Fact]
    public async Task NamedPipeRpcServer_StartAsync_Cancellation_Throws()
    {
        var server = new NamedPipeRpcServer("test-pipe", NullLogger<NamedPipeRpcServer>.Instance);
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => server.StartAsync((_, _) => ValueTask.FromResult<HookApproval>(null!), cts.Token).AsTask());
        await server.DisposeAsync();
    }

    [Fact]
    public async Task NamedPipeRpcServer_StartThenStop_DoesNotThrow()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;

        var pipeName = "test-pipe-" + Guid.NewGuid().ToString("N");
        var server = new NamedPipeRpcServer(pipeName, NullLogger<NamedPipeRpcServer>.Instance);
        await server.StartAsync((_, _) => ValueTask.FromResult<HookApproval>(null!), CancellationToken.None);
        await server.StopAsync(CancellationToken.None);
        await server.DisposeAsync();
    }

    [Fact]
    public async Task NamedPipeRpcServer_StartAsync_WithPipePrefix_Strips()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;

        var pipeName = @"\\.\pipe\test-prefix-" + Guid.NewGuid().ToString("N");
        var server = new NamedPipeRpcServer(pipeName, NullLogger<NamedPipeRpcServer>.Instance);
        await server.StartAsync((_, _) => ValueTask.FromResult<HookApproval>(null!), CancellationToken.None);
        await server.StopAsync(CancellationToken.None);
        await server.DisposeAsync();
    }
}
