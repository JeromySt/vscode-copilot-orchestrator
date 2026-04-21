// <copyright file="IShellRunner.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Shell;

/// <summary>
/// Runs a single shell <see cref="ShellSpec"/> in a hardened environment, satisfying
/// PS-ISO-1..5 (PowerShell hardening) and CMD-TMP-1 (atomic owner-only temp script).
/// </summary>
public interface IShellRunner
{
    /// <summary>Runs the script described by <paramref name="spec"/> under the supplied <paramref name="ctx"/>.</summary>
    /// <param name="spec">The shell invocation to execute.</param>
    /// <param name="ctx">Identifies the run for events / telemetry.</param>
    /// <param name="ct">Cancellation token; cancellation triggers the same SIGTERM/SIGKILL escalation as a timeout.</param>
    /// <returns>The result of the run, including exit code and byte counts.</returns>
    /// <exception cref="Exceptions.WorkingDirectoryNotFoundException">
    /// Raised before any process is spawned when <see cref="ShellSpec.WorkingDirectory"/> does not exist.
    /// </exception>
    ValueTask<ShellRunResult> RunAsync(ShellSpec spec, RunContext ctx, CancellationToken ct);
}
