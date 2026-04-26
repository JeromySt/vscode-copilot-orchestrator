// <copyright file="FakeProcessSpawner.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Concurrent;
using System.IO.Pipelines;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Models;

namespace AiOrchestrator.Agent.Tests.Fakes;

/// <summary>Fake process spawner that records specs and yields <see cref="FakeProcessHandle"/>s.</summary>
public sealed class FakeProcessSpawner : IProcessSpawner
{
    private int nextPid = 8000;

    /// <summary>Gets every spec passed to this spawner.</summary>
    public ConcurrentQueue<ProcessSpec> SpawnedSpecs { get; } = new();

    /// <summary>Gets every handle this spawner returned.</summary>
    public ConcurrentQueue<FakeProcessHandle> SpawnedHandles { get; } = new();

    /// <summary>Optional callback invoked when a new handle is created.</summary>
    public Action<FakeProcessHandle>? OnSpawn { get; set; }

    /// <inheritdoc/>
    public ValueTask<IProcessHandle> SpawnAsync(ProcessSpec spec, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        this.SpawnedSpecs.Enqueue(spec);
        var handle = new FakeProcessHandle(System.Threading.Interlocked.Increment(ref this.nextPid));
        this.SpawnedHandles.Enqueue(handle);
        this.OnSpawn?.Invoke(handle);
        return ValueTask.FromResult<IProcessHandle>(handle);
    }
}

/// <summary>Fake handle exposing in-memory pipes and recording signals.</summary>
public sealed class FakeProcessHandle : IProcessHandle
{
    private readonly Pipe stdoutPipe = new();
    private readonly Pipe stderrPipe = new();
    private readonly Pipe stdinPipe = new();
    private readonly TaskCompletionSource<int> exit = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int disposed;

    /// <summary>Initializes a new instance of the <see cref="FakeProcessHandle"/> class.</summary>
    /// <param name="pid">The fake process id.</param>
    public FakeProcessHandle(int pid) => this.ProcessId = pid;

    /// <inheritdoc/>
    public int ProcessId { get; }

    /// <inheritdoc/>
    public PipeReader StandardOut => this.stdoutPipe.Reader;

    /// <inheritdoc/>
    public PipeReader StandardError => this.stderrPipe.Reader;

    /// <inheritdoc/>
    public PipeWriter StandardIn => this.stdinPipe.Writer;

    /// <summary>Gets the signals sent so far.</summary>
    public List<ProcessSignal> SignalsSent { get; } = new();

    /// <inheritdoc/>
    public ValueTask<ProcessTreeNode?> GetProcessTreeAsync(CancellationToken ct) => ValueTask.FromResult<ProcessTreeNode?>(null);

    /// <summary>Optional handler invoked when a signal arrives.</summary>
    public Action<ProcessSignal>? OnSignal { get; set; }

    /// <summary>Completes the handle with an exit code.</summary>
    /// <param name="exitCode">The exit code.</param>
    public void Complete(int exitCode = 0)
    {
        try
        {
            this.stdoutPipe.Writer.Complete();
        }
        catch (InvalidOperationException)
        {
        }

        try
        {
            this.stderrPipe.Writer.Complete();
        }
        catch (InvalidOperationException)
        {
        }

        _ = this.exit.TrySetResult(exitCode);
    }

    /// <summary>Writes bytes to stdout.</summary>
    /// <param name="data">Bytes.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>Awaitable.</returns>
    public async ValueTask WriteStdoutAsync(ReadOnlyMemory<byte> data, CancellationToken ct = default)
    {
        _ = await this.stdoutPipe.Writer.WriteAsync(data, ct).ConfigureAwait(false);
        _ = await this.stdoutPipe.Writer.FlushAsync(ct).ConfigureAwait(false);
    }

    /// <summary>Writes text followed by newline to stdout.</summary>
    /// <param name="text">Text.</param>
    /// <returns>Awaitable.</returns>
    public ValueTask WriteStdoutLineAsync(string text)
        => this.WriteStdoutAsync(System.Text.Encoding.UTF8.GetBytes(text + "\n"));

    /// <inheritdoc/>
    public Task<int> WaitForExitAsync(CancellationToken ct)
        => ct.CanBeCanceled ? this.exit.Task.WaitAsync(ct) : this.exit.Task;

    /// <inheritdoc/>
    public ValueTask SignalAsync(ProcessSignal signal, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        this.SignalsSent.Add(signal);
        this.OnSignal?.Invoke(signal);
        if (signal == ProcessSignal.Kill)
        {
            this.Complete(-1);
        }

        return ValueTask.CompletedTask;
    }

    /// <inheritdoc/>
    public ValueTask DisposeAsync()
    {
        if (System.Threading.Interlocked.Exchange(ref this.disposed, 1) != 0)
        {
            return ValueTask.CompletedTask;
        }

        _ = this.exit.TrySetResult(-1);
        try
        {
            this.stdoutPipe.Writer.Complete();
        }
        catch (InvalidOperationException)
        {
        }

        try
        {
            this.stderrPipe.Writer.Complete();
        }
        catch (InvalidOperationException)
        {
        }

        try
        {
            this.stdinPipe.Reader.Complete();
        }
        catch (InvalidOperationException)
        {
        }

        return ValueTask.CompletedTask;
    }
}
