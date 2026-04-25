// <copyright file="ProcessHandleCoverageTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.IO.Pipelines;
using System.Text;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Models;
using Xunit;

namespace AiOrchestrator.Process.Tests;

/// <summary>Coverage tests for <see cref="ProcessHandle"/> error paths, disposal, and signal handling.</summary>
public sealed class ProcessHandleCoverageTests
{
    private static readonly FakeProcessLifecycle Lifecycle = new();
    private static readonly FakeClock Clock = new();
    private static readonly FakeTelemetrySink Telemetry = new();
    private static readonly ProcessSpawner Spawner = new(Lifecycle, Clock, Telemetry);

    private static bool IsWindows => System.Runtime.InteropServices.RuntimeInformation
        .IsOSPlatform(System.Runtime.InteropServices.OSPlatform.Windows);

    private static ProcessSpec EchoSpec(string message)
        => IsWindows
            ? new() { Producer = "test", Description = "echo", Executable = "cmd.exe", Arguments = ["/c", $"echo {message}"], Environment = null }
            : new() { Producer = "test", Description = "echo", Executable = "/bin/sh", Arguments = ["-c", $"echo {message}"], Environment = null };

    private static ProcessSpec ExitSpec(int code)
        => IsWindows
            ? new() { Producer = "test", Description = "exit", Executable = "cmd.exe", Arguments = ["/c", $"exit {code}"], Environment = null }
            : new() { Producer = "test", Description = "exit", Executable = "/bin/sh", Arguments = ["-c", $"exit {code}"], Environment = null };

    private static ProcessSpec SleepSpec(int seconds)
        => IsWindows
            ? new() { Producer = "test", Description = "sleep", Executable = "ping", Arguments = ["-n", (seconds + 1).ToString(), "127.0.0.1"], Environment = null }
            : new() { Producer = "test", Description = "sleep", Executable = "/bin/sh", Arguments = ["-c", $"sleep {seconds}"], Environment = null };

    /// <summary>WaitForExitAsync with a cancellation token that fires before exit should throw OperationCanceledException.</summary>
    [Fact]
    public async Task WaitForExit_WithCancelledToken_ThrowsOperationCanceled()
    {
        var spec = SleepSpec(60);
        await using var handle = await Spawner.SpawnAsync(spec, CancellationToken.None);

        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => handle.WaitForExitAsync(cts.Token));
    }

    /// <summary>WaitForExitAsync with a non-cancellable token returns the raw task.</summary>
    [Fact]
    public async Task WaitForExit_NonCancellableToken_ReturnsResult()
    {
        var spec = ExitSpec(0);
        await using var handle = await Spawner.SpawnAsync(spec, CancellationToken.None);

        var exitCode = await handle.WaitForExitAsync(CancellationToken.None)
            .WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal(0, exitCode);
    }

    /// <summary>SignalAsync with an already-cancelled token throws immediately.</summary>
    [Fact]
    public async Task SignalAsync_CancelledToken_ThrowsOperationCanceled()
    {
        var spec = SleepSpec(60);
        await using var handle = await Spawner.SpawnAsync(spec, CancellationToken.None);

        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAsync<OperationCanceledException>(
            async () => await handle.SignalAsync(ProcessSignal.Terminate, cts.Token));
    }

    /// <summary>DisposeAsync on an already-exited process does not throw.</summary>
    [Fact]
    public async Task DisposeAsync_AfterProcessExits_DoesNotThrow()
    {
        var spec = ExitSpec(0);
        var handle = await Spawner.SpawnAsync(spec, CancellationToken.None);

        await handle.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(30));

        // Dispose after natural exit — should not throw
        await handle.DisposeAsync();
        await handle.DisposeAsync(); // Idempotent
    }

    /// <summary>Non-zero exit triggers crash dump capture via IProcessLifecycle.</summary>
    [Fact]
    public async Task NonZeroExit_TriggersCrashDumpCapture()
    {
        var lifecycle = new FakeProcessLifecycle();
        var spawner = new ProcessSpawner(lifecycle, Clock, Telemetry);
        var spec = ExitSpec(1);

        await using var handle = await spawner.SpawnAsync(spec, CancellationToken.None);
        var exitCode = await handle.WaitForExitAsync(CancellationToken.None)
            .WaitAsync(TimeSpan.FromSeconds(30));

        Assert.Equal(1, exitCode);
        // Give a moment for the fire-and-forget crash dump to run
        await Task.Delay(200);
        Assert.True(lifecycle.Captures.Count >= 1, "Expected at least one crash dump capture for non-zero exit");
    }

    /// <summary>CancelAsync on an already-exited process is a no-op.</summary>
    [Fact]
    public async Task CancelAsync_AlreadyExited_IsNoOp()
    {
        var spec = ExitSpec(0);
        var handle = (ProcessHandle)(await Spawner.SpawnAsync(spec, CancellationToken.None));

        await handle.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(30));

        // Should not throw — early return because HasExited is true
        await handle.CancelAsync(TimeSpan.FromSeconds(1));

        await handle.DisposeAsync();
    }

    /// <summary>CancelAsync sends SIGTERM then SIGKILL on timeout.</summary>
    [Fact]
    public async Task CancelAsync_WithGracePeriod_ForceKillsAfterTimeout()
    {
        var spec = SleepSpec(60);
        var handle = (ProcessHandle)(await Spawner.SpawnAsync(spec, CancellationToken.None));

        // Very short grace period to trigger the SIGKILL branch
        await handle.CancelAsync(TimeSpan.FromMilliseconds(200));

        // Process should now be dead
        var exitCode = await handle.WaitForExitAsync(CancellationToken.None)
            .WaitAsync(TimeSpan.FromSeconds(10));

        await handle.DisposeAsync();
    }

    /// <summary>ProcessId is positive for a spawned process.</summary>
    [Fact]
    public async Task ProcessId_IsPositive()
    {
        var spec = EchoSpec("pid-check");
        await using var handle = await Spawner.SpawnAsync(spec, CancellationToken.None);
        Assert.True(handle.ProcessId > 0);
        await handle.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(30));
    }

    /// <summary>StandardIn pipe is writable (basic write does not throw).</summary>
    [Fact]
    public async Task StandardIn_IsWritable()
    {
        // Spawn a process that reads stdin — cmd /c "set /p x=" on Windows, cat on Linux
        var spec = IsWindows
            ? new ProcessSpec { Producer = "test", Description = "stdin", Executable = "cmd.exe", Arguments = ["/c", "set /p x="], Environment = null }
            : new ProcessSpec { Producer = "test", Description = "stdin", Executable = "/bin/cat", Arguments = [], Environment = null };

        await using var handle = await Spawner.SpawnAsync(spec, CancellationToken.None);

        // Write to stdin then complete
        var data = Encoding.UTF8.GetBytes("hello\n");
        await handle.StandardIn.WriteAsync(new ReadOnlyMemory<byte>(data));
        await handle.StandardIn.CompleteAsync();

        await handle.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(30));
    }

    /// <summary>ApplyLimits static method does not throw for the current platform.</summary>
    [Fact]
    public void ApplyLimits_DoesNotThrow_ForCurrentPlatform()
    {
        // Use a dummy PID; the call is best-effort and should not throw even for invalid PIDs.
        var limits = new ResourceLimits
        {
            MaxMemoryBytes = 1024 * 1024 * 512,
            MaxCpuTime = TimeSpan.FromMinutes(5),
            MaxProcesses = 10,
        };

        // Should not throw — best effort
        ProcessSpawner.ApplyLimits(int.MaxValue, limits);
    }

    /// <summary>Telemetry records process.spawn and process.exit counters.</summary>
    [Fact]
    public async Task Telemetry_RecordsSpawnAndExitCounters()
    {
        var telemetry = new FakeTelemetrySink();
        var spawner = new ProcessSpawner(Lifecycle, Clock, telemetry);
        var spec = ExitSpec(0);

        await using var handle = await spawner.SpawnAsync(spec, CancellationToken.None);
        await handle.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(30));

        // Wait briefly for the Exited event handler to fire
        await Task.Delay(100);

        Assert.Contains(telemetry.Counters, c => c.Name == "process.spawn");
        Assert.Contains(telemetry.Counters, c => c.Name == "process.exit");
    }
}
