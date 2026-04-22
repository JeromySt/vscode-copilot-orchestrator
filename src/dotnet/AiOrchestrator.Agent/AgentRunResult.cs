// <copyright file="AgentRunResult.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Agent;

/// <summary>Result of a single <see cref="IAgentRunner.RunAsync"/> invocation.</summary>
public sealed record AgentRunResult
{
    /// <summary>Gets the runner's process exit code. May be negative when the process was signaled.</summary>
    public required int ExitCode { get; init; }

    /// <summary>Gets the session id emitted by the runner, if parsed.</summary>
    public required string? SessionId { get; init; }

    /// <summary>Gets the aggregated agent statistics (always non-null; see INV-5).</summary>
    public required AgentStats Stats { get; init; }

    /// <summary>Gets the wall-clock duration of the run.</summary>
    public required TimeSpan Duration { get; init; }

    /// <summary>Gets a value indicating whether the task-complete handler observed the runner-specific "done" marker (INV-6).</summary>
    public required bool TaskCompleteEmitted { get; init; }

    /// <summary>Gets the files the runner reported as changed, if any.</summary>
    public required ImmutableArray<RepoRelativePath> ChangedFiles { get; init; }

    /// <summary>Gets a value indicating whether the run was terminated because <see cref="AgentSpec.MaxTurns"/> was exceeded (INV-9).</summary>
    public bool MaxTurnsExceeded { get; init; }

    /// <summary>Gets a value indicating whether the runner emitted an <c>AgentSandboxUnsupported</c> warning (INV-10).</summary>
    public bool SandboxUnsupportedWarning { get; init; }
}
