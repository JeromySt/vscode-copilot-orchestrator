// <copyright file="IProcessLifecycle.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Process.Lifecycle;

/// <summary>
/// Handles process lifecycle events that occur outside the normal exit path,
/// such as crash-dump capture on abnormal termination.
/// </summary>
public interface IProcessLifecycle
{
    /// <summary>
    /// Captures a crash dump for the specified process, writing the output to <paramref name="outputPath"/>.
    /// Failures are logged but must not propagate exceptions to the caller.
    /// </summary>
    /// <param name="pid">The operating-system process identifier of the crashed process.</param>
    /// <param name="outputPath">The absolute path at which to write the dump file.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when the capture attempt has finished.</returns>
    ValueTask CaptureCrashDumpAsync(int pid, AbsolutePath outputPath, CancellationToken ct);
}
