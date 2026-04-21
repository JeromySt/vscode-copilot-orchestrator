// <copyright file="IAgentEventSink.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Agent;

/// <summary>
/// Callback sink invoked by runners as they observe session ids, stats, completion,
/// and context pressure. One sink instance is passed into a single run.
/// </summary>
public interface IAgentEventSink
{
    /// <summary>Invoked when a session id has been parsed from runner output (INV-4).</summary>
    /// <param name="sessionId">The parsed session identifier.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when the sink has processed the notification.</returns>
    ValueTask OnSessionIdAsync(string sessionId, CancellationToken ct);

    /// <summary>Invoked when updated stats have been parsed from runner output (INV-5).</summary>
    /// <param name="stats">The latest aggregated statistics.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when the sink has processed the notification.</returns>
    ValueTask OnStatsAsync(AgentStats stats, CancellationToken ct);

    /// <summary>Invoked when the runner's "done" marker has been observed (INV-6).</summary>
    /// <param name="finalResponse">The last reported response text, if any.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when the sink has processed the notification.</returns>
    ValueTask OnTaskCompleteAsync(string finalResponse, CancellationToken ct);

    /// <summary>Invoked when the rolling context-pressure tracker crosses a threshold (INV-7).</summary>
    /// <param name="level">The new pressure level.</param>
    /// <param name="fractionUsed">The fraction of the context window currently used (0..1).</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when the sink has processed the notification.</returns>
    ValueTask OnContextPressureAsync(ContextPressureLevel level, double fractionUsed, CancellationToken ct);

    /// <summary>Invoked for every raw line read from the agent process, pre-handler.</summary>
    /// <param name="line">The raw line record.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when the sink has processed the notification.</returns>
    ValueTask OnRawLineAsync(LineEmitted line, CancellationToken ct);
}
