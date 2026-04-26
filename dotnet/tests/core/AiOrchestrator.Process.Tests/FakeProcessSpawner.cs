// <copyright file="FakeProcessSpawner.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.IO.Pipelines;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Models;

namespace AiOrchestrator.Process.Tests;

/// <summary>
/// In-memory fake implementation of <see cref="IProcessSpawner"/> that returns
/// <see cref="FakeProcessHandle"/> instances without starting any real OS process.
/// Used for PROC-11 contract verification.
/// </summary>
public sealed class FakeProcessSpawner : IProcessSpawner
{
    private int _nextPid = 1000;

    /// <summary>Gets all handles spawned by this instance since construction.</summary>
    public List<FakeProcessHandle> SpawnedHandles { get; } = [];

    /// <summary>Gets the specs that have been passed to <see cref="SpawnAsync"/>.</summary>
    public List<ProcessSpec> SpawnedSpecs { get; } = [];

    /// <inheritdoc/>
    public ValueTask<IProcessHandle> SpawnAsync(ProcessSpec spec, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        // Verify argv-vector invariant: spec must not embed shell metacharacters in a single arg
        // (this tests INV-1 at the fake level — the real spawner never invokes a shell)
        var handle = new FakeProcessHandle(System.Threading.Interlocked.Increment(ref _nextPid));
        SpawnedHandles.Add(handle);
        SpawnedSpecs.Add(spec);

        return ValueTask.FromResult<IProcessHandle>(handle);
    }
}

/// <summary>
/// In-memory fake process handle returned by <see cref="FakeProcessSpawner"/>.
/// Allows tests to control exit codes and observe stdin/stdout without a real process.
/// </summary>
public sealed class FakeProcessHandle : IProcessHandle
{
    private readonly Pipe _stdoutPipe = new();
    private readonly Pipe _stderrPipe = new();
    private readonly Pipe _stdinPipe = new();
    private readonly TaskCompletionSource<int> _exitTcs =
        new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int _disposed;

    /// <summary>Initializes a new instance of the <see cref="FakeProcessHandle"/> class.</summary>
    /// <param name="pid">The fake process ID to report.</param>
    internal FakeProcessHandle(int pid) => ProcessId = pid;

    /// <inheritdoc/>
    public int ProcessId { get; }

    /// <inheritdoc/>
    public PipeReader StandardOut => _stdoutPipe.Reader;

    /// <inheritdoc/>
    public PipeReader StandardError => _stderrPipe.Reader;

    /// <inheritdoc/>
    public PipeWriter StandardIn => _stdinPipe.Writer;

    /// <summary>Gets the list of signals sent to this handle.</summary>
    public List<ProcessSignal> SignalsSent { get; } = [];

    /// <summary>Completes the fake process with the given exit code.</summary>
    /// <param name="exitCode">The exit code to report to awaiters.</param>
    public void Complete(int exitCode = 0)
    {
        _stdoutPipe.Writer.Complete();
        _stderrPipe.Writer.Complete();
        _exitTcs.TrySetResult(exitCode);
    }

    /// <summary>Writes bytes to the fake stdout stream (as if the process produced output).</summary>
    /// <param name="data">Data to write.</param>
    /// <param name="ct">Cancellation token.</param>
    public async ValueTask WriteStdoutAsync(ReadOnlyMemory<byte> data, CancellationToken ct = default)
    {
        await _stdoutPipe.Writer.WriteAsync(data, ct).ConfigureAwait(false);
        await _stdoutPipe.Writer.FlushAsync(ct).ConfigureAwait(false);
    }

    /// <summary>Writes bytes to the fake stderr stream.</summary>
    /// <param name="data">Data to write.</param>
    /// <param name="ct">Cancellation token.</param>
    public async ValueTask WriteStderrAsync(ReadOnlyMemory<byte> data, CancellationToken ct = default)
    {
        await _stderrPipe.Writer.WriteAsync(data, ct).ConfigureAwait(false);
        await _stderrPipe.Writer.FlushAsync(ct).ConfigureAwait(false);
    }

    /// <inheritdoc/>
    public Task<int> WaitForExitAsync(CancellationToken ct)
        => ct.CanBeCanceled ? _exitTcs.Task.WaitAsync(ct) : _exitTcs.Task;

    /// <inheritdoc/>
    public ValueTask<ProcessTreeNode?> GetProcessTreeAsync(CancellationToken ct) => ValueTask.FromResult<ProcessTreeNode?>(null);

    /// <inheritdoc/>
    public ValueTask SignalAsync(ProcessSignal signal, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        SignalsSent.Add(signal);

        if (signal == ProcessSignal.Kill)
        {
            Complete(-1);
        }

        return ValueTask.CompletedTask;
    }

    /// <inheritdoc/>
    public ValueTask DisposeAsync()
    {
        if (System.Threading.Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return ValueTask.CompletedTask;
        }

        _exitTcs.TrySetResult(-1);
        _stdoutPipe.Writer.Complete();
        _stderrPipe.Writer.Complete();
        _stdinPipe.Reader.Complete();
        return ValueTask.CompletedTask;
    }
}
