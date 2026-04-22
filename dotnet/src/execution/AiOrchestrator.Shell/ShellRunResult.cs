// <copyright file="ShellRunResult.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Shell;

/// <summary>The result of a single <see cref="IShellRunner.RunAsync"/> invocation.</summary>
public sealed record ShellRunResult
{
    /// <summary>Gets the process exit code (or <c>-1</c> when force-killed after timeout).</summary>
    public required int ExitCode { get; init; }

    /// <summary>Gets the wall-clock duration of the run, measured by <c>IClock</c>.</summary>
    public required TimeSpan Duration { get; init; }

    /// <summary>Gets the total number of bytes read from the process's stdout stream.</summary>
    public required long StdoutBytes { get; init; }

    /// <summary>Gets the total number of bytes read from the process's stderr stream.</summary>
    public required long StderrBytes { get; init; }

    /// <summary>Gets a value indicating whether the run was terminated because it exceeded its timeout.</summary>
    public required bool TimedOut { get; init; }
}
