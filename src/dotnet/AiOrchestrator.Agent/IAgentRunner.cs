// <copyright file="IAgentRunner.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Agent;

/// <summary>
/// Executes an <see cref="AgentSpec"/> via a specific agent CLI, forwarding parsed events
/// to an <see cref="IAgentEventSink"/> and producing an <see cref="AgentRunResult"/>.
/// </summary>
public interface IAgentRunner
{
    /// <summary>Gets the runner kind this instance implements.</summary>
    AgentRunnerKind Kind { get; }

    /// <summary>Runs the supplied spec.</summary>
    /// <param name="spec">The invocation specification.</param>
    /// <param name="ctx">Identifies the run for events / telemetry.</param>
    /// <param name="sink">Callback sink for session / stats / completion events.</param>
    /// <param name="ct">Cancellation token; cancellation triggers a SIGTERM→SIGKILL escalation.</param>
    /// <returns>The terminal <see cref="AgentRunResult"/>.</returns>
    /// <exception cref="AgentRunnerNotInstalledException">
    /// Raised if the underlying executable could not be located on <c>PATH</c> (INV-12).
    /// </exception>
    ValueTask<AgentRunResult> RunAsync(AgentSpec spec, RunContext ctx, IAgentEventSink sink, CancellationToken ct);
}
