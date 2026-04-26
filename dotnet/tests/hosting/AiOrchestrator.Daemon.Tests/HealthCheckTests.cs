// <copyright file="HealthCheckTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Daemon.Update;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace AiOrchestrator.Daemon.Tests;

public sealed class HealthCheckTests
{
    [Fact]
    public async Task RunAsync_ExitZero_ReturnsOk()
    {
        var spawner = new FakeProcessSpawner { ExitCode = 0 };
        var health = new HealthCheck(spawner, NullLogger<HealthCheck>.Instance);

        var result = await health.RunAsync(new AbsolutePath("/tmp/daemon"), CancellationToken.None);

        Assert.True(result.Ok);
        Assert.Null(result.FailureReason);
    }

    [Fact]
    public async Task RunAsync_NonZeroExit_ReturnsFailure()
    {
        var spawner = new FakeProcessSpawner { ExitCode = 42 };
        var health = new HealthCheck(spawner, NullLogger<HealthCheck>.Instance);

        var result = await health.RunAsync(new AbsolutePath("/tmp/daemon"), CancellationToken.None);

        Assert.False(result.Ok);
        Assert.Contains("42", result.FailureReason);
    }

    [Fact]
    public async Task RunAsync_Cancellation_Propagates()
    {
        // Spawner that simulates a long-running process which hangs until cancelled.
        var spawner = new HangingProcessSpawner();
        var health = new HealthCheck(spawner, NullLogger<HealthCheck>.Instance);

        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        // The HealthCheck creates a linked CTS internally; with our token already cancelled
        // the spawner's WaitForExitAsync should throw OperationCanceledException.
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => health.RunAsync(new AbsolutePath("/tmp/daemon"), cts.Token).AsTask());
    }

    private sealed class HangingProcessSpawner : AiOrchestrator.Abstractions.Process.IProcessSpawner
    {
        public ValueTask<AiOrchestrator.Abstractions.Process.IProcessHandle> SpawnAsync(
            AiOrchestrator.Models.ProcessSpec spec, CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();
            return ValueTask.FromResult<AiOrchestrator.Abstractions.Process.IProcessHandle>(new HangingHandle());
        }

        private sealed class HangingHandle : AiOrchestrator.Abstractions.Process.IProcessHandle
        {
            private readonly System.IO.Pipelines.Pipe stdoutPipe = new();
            private readonly System.IO.Pipelines.Pipe stderrPipe = new();
            private readonly System.IO.Pipelines.Pipe stdinPipe = new();

            public HangingHandle()
            {
                this.stdoutPipe.Writer.Complete();
                this.stderrPipe.Writer.Complete();
            }

            public int ProcessId => 0;

            public System.IO.Pipelines.PipeReader StandardOut => this.stdoutPipe.Reader;

            public System.IO.Pipelines.PipeReader StandardError => this.stderrPipe.Reader;

            public System.IO.Pipelines.PipeWriter StandardIn => this.stdinPipe.Writer;

            public async Task<int> WaitForExitAsync(CancellationToken ct)
            {
                await Task.Delay(System.Threading.Timeout.Infinite, ct);
                return -1;
            }

            public ValueTask<AiOrchestrator.Abstractions.Process.ProcessTreeNode?> GetProcessTreeAsync(CancellationToken ct) => ValueTask.FromResult<AiOrchestrator.Abstractions.Process.ProcessTreeNode?>(null);

            public ValueTask SignalAsync(AiOrchestrator.Abstractions.Process.ProcessSignal signal, CancellationToken ct) => ValueTask.CompletedTask;

            public ValueTask DisposeAsync() => ValueTask.CompletedTask;
        }
    }
}
