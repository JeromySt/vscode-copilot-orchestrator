// <copyright file="HookGateCoverageGap2Tests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.HookGate.Immutability;
using AiOrchestrator.HookGate.Redirection;
using AiOrchestrator.HookGate.Validation;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.TestKit.Time;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace AiOrchestrator.HookGate.Tests;

/// <summary>Targeted coverage-gap tests for HookGate assembly (~10 lines).</summary>
public sealed class HookGateCoverageGap2Tests : IDisposable
{
    private readonly System.Collections.Generic.List<string> tempDirs = new();

    public void Dispose()
    {
        foreach (var d in this.tempDirs)
        {
            try { Directory.Delete(d, true); } catch { }
        }
    }

    private string MakeTempDir()
    {
        var d = Path.Combine(Path.GetTempPath(), "hg-gap2-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(d);
        this.tempDirs.Add(d);
        return d;
    }

    // ================================================================
    // WindowsRedirectionManager â€” constructor null guards
    // ================================================================

    [Fact]
    public void WindowsRedirectionManager_Constructor_NullEvents_Throws()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;

        Assert.Throws<ArgumentNullException>(() =>
            new WindowsRedirectionManager(null!, new NullProcessSpawner(), new PassthroughFileSystem(), NullLogger<WindowsRedirectionManager>.Instance));
    }

    [Fact]
    public void WindowsRedirectionManager_Constructor_NullSpawner_Throws()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;

        Assert.Throws<ArgumentNullException>(() =>
            new WindowsRedirectionManager(new InMemoryImmutabilitySink(), null!, new PassthroughFileSystem(), NullLogger<WindowsRedirectionManager>.Instance));
    }

    [Fact]
    public void WindowsRedirectionManager_Constructor_NullLogger_Throws()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;

        Assert.Throws<ArgumentNullException>(() =>
            new WindowsRedirectionManager(new InMemoryImmutabilitySink(), new NullProcessSpawner(), new PassthroughFileSystem(), null!));
    }

    // ================================================================
    // WindowsRedirectionManager â€” GetActiveMode for regular (non-reparse) directory
    // ================================================================

    [Fact]
    public async Task WindowsRedirectionManager_GetActiveMode_RegularDir_ReturnsNotInstalled()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;

        var sink = new InMemoryImmutabilitySink();
        var spawner = new NullProcessSpawner();
        var mgr = new WindowsRedirectionManager(sink, spawner, new PassthroughFileSystem(), NullLogger<WindowsRedirectionManager>.Instance);

        // A regular directory without a reparse point
        var dir = MakeTempDir();

        var mode = await mgr.GetActiveModeAsync(new AbsolutePath(dir), CancellationToken.None);

        Assert.Equal(RedirectionMode.NotInstalled, mode);
    }

    // ================================================================
    // WindowsRedirectionManager â€” Uninstall cancellation
    // ================================================================

    [Fact]
    public async Task WindowsRedirectionManager_Uninstall_Cancelled_Throws()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;

        var sink = new InMemoryImmutabilitySink();
        var spawner = new NullProcessSpawner();
        var mgr = new WindowsRedirectionManager(sink, spawner, new PassthroughFileSystem(), NullLogger<WindowsRedirectionManager>.Instance);

        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => mgr.UninstallRedirectionAsync(new AbsolutePath("/test"), cts.Token).AsTask());
    }

    // ================================================================
    // WindowsRedirectionManager â€” Install cancellation
    // ================================================================

    [Fact]
    public async Task WindowsRedirectionManager_Install_Cancelled_Throws()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;

        var sink = new InMemoryImmutabilitySink();
        var spawner = new NullProcessSpawner();
        var mgr = new WindowsRedirectionManager(sink, spawner, new PassthroughFileSystem(), NullLogger<WindowsRedirectionManager>.Instance);

        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => mgr.InstallRedirectionAsync(new AbsolutePath("/test"), new AbsolutePath("/target"), cts.Token).AsTask());
    }

    // ================================================================
    // ImmutabilityProbe â€” BuildEvent with valid result
    // ================================================================

    [Fact]
    public void ImmutabilityProbe_BuildEvent_WithValidResult_UsesValues()
    {
        var clock = new InMemoryClock();
        var spawner = new NullProcessSpawner();
        var probe = new ImmutabilityProbe(clock, spawner);

        var result = new ImmutabilityResult
        {
            Supported = false,
            Mechanism = "DACL-deny",
            FailureReason = "exit 5",
        };

        var evt = probe.BuildEvent(new AbsolutePath("/test/hooks"), result);

        Assert.Equal("DACL-deny", evt.Mechanism);
        Assert.Equal("exit 5", evt.Reason);
        Assert.Equal("/test/hooks", evt.Path.Value);
    }

    // ================================================================
    // ImmutabilityProbe â€” IsImmutabilitySupported true path
    // ================================================================

    [Fact]
    public void ImmutabilityProbe_IsImmutabilitySupported_Supported_ReturnsTrue()
    {
        var clock = new InMemoryClock();
        var spawner = new NullProcessSpawner();
        var probe = new ImmutabilityProbe(clock, spawner);

        var result = new ImmutabilityResult { Supported = true, Mechanism = "DACL-deny", FailureReason = null };

        Assert.True(probe.IsImmutabilitySupported(result));
    }

    // ================================================================
    // LinkValidator â€” cancellation
    // ================================================================

    [Fact]
    public async Task LinkValidator_Windows_NormalFile_OutsideWorktree_ReturnsOk()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return;

        var dir = MakeTempDir();
        var hookFile = Path.Combine(dir, "post-commit");
        File.WriteAllText(hookFile, "#!/bin/sh\nexit 0\n");

        var parentDir = Path.GetDirectoryName(dir)!;

        var validator = new LinkValidator(new PassthroughFileSystem());
        var result = await validator.ValidateAsync(
            new AbsolutePath(hookFile),
            new AbsolutePath(parentDir),
            CancellationToken.None);

        Assert.True(result.Ok);
    }
}
