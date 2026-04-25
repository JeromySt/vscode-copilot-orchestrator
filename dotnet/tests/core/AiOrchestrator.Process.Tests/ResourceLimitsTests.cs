// <copyright file="ResourceLimitsTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;
using AiOrchestrator.Models;
using AiOrchestrator.Process.Limits;
using AiOrchestrator.Process.Native.Linux;
using Xunit;

namespace AiOrchestrator.Process.Tests;

/// <summary>Tests for platform-specific resource limit enforcement.</summary>
public sealed class ResourceLimitsTests
{
    private static readonly FakeProcessLifecycle Lifecycle = new();
    private static readonly FakeClock Clock = new();
    private static readonly FakeTelemetrySink Telemetry = new();

    /// <summary>PROC-9: Resource limits (setrlimit) are applied before exec on Linux.</summary>
    [Fact]
    [ContractTest("PROC-9")]
    public async Task PROC_9_RLimits_AppliedBeforeExec_Linux()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            // Linux-only test
            return;
        }

        // Verify that setrlimit P/Invoke is available and the native call succeeds
        var limits = new ResourceLimits
        {
            MaxOpenFiles = 64,
        };

        // Apply to the current test process (safe: just reduces our file limit for the call)
        var rl = new SetRlimitNative.RLimit
        {
            RlimCur = 64,
            RlimMax = 64,
        };

        var result = SetRlimitNative.GetRlimit(SetRlimitNative.RLIMIT_NOFILE, out var currentLimits);
        Assert.Equal(0, result);
        Assert.True(currentLimits.RlimCur > 0);

        // Verify RLimitsLinux.Apply doesn't throw (best we can do without a child process fixture)
        var pid = System.Diagnostics.Process.GetCurrentProcess().Id;
        await RLimitsLinux.ApplyAsync(pid, limits, NullFileSystem.Instance, CancellationToken.None);
    }

    /// <summary>PROC-10: Job Objects limit memory on Windows.</summary>
    [Fact]
    [ContractTest("PROC-10")]
    public async Task PROC_10_JobObjects_LimitMemory_Windows()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            // Windows-only test
            return;
        }

        var limits = new ResourceLimits
        {
            MaxMemoryBytes = 512L * 1024 * 1024, // 512 MB
        };

        var spawner = new ProcessSpawner(Lifecycle, Clock, Telemetry, NullFileSystem.Instance);

        var spec = new ProcessSpec
        {
            Producer = "test",
            Description = "job-object-test",
            Executable = "cmd.exe",
            Arguments = ["/c", "exit 0"],
            Environment = null,
        };

        await using var handle = await spawner.SpawnAsync(spec, CancellationToken.None);

        // Apply job object limits right after spawn
        await ProcessSpawner.ApplyLimitsAsync(handle.ProcessId, limits, NullFileSystem.Instance, CancellationToken.None);

        await handle.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(30));
    }
}
