// <copyright file="IProcessHandle.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.IO.Pipelines;

namespace AiOrchestrator.Abstractions.Process;

/// <summary>
/// Represents a handle to a running child process, providing access to its stdio streams
/// and lifecycle management. Dispose to release handle resources; the process may continue
/// running until explicitly signaled.
/// </summary>
public interface IProcessHandle : IAsyncDisposable
{
    /// <summary>Gets the operating-system process identifier.</summary>
    int ProcessId { get; }

    /// <summary>Gets a pipe reader connected to the process's standard output stream.</summary>
    PipeReader StandardOut { get; }

    /// <summary>Gets a pipe reader connected to the process's standard error stream.</summary>
    PipeReader StandardError { get; }

    /// <summary>Gets a pipe writer connected to the process's standard input stream.</summary>
    PipeWriter StandardIn { get; }

    /// <summary>Waits asynchronously for the process to exit and returns its exit code.</summary>
    /// <param name="ct">Cancellation token. Cancellation does not kill the process.</param>
    /// <returns>The process exit code.</returns>
    Task<int> WaitForExitAsync(CancellationToken ct);

    /// <summary>Sends a signal to the process.</summary>
    /// <param name="signal">The signal to send.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when the signal has been delivered.</returns>
    ValueTask SignalAsync(ProcessSignal signal, CancellationToken ct);
}
