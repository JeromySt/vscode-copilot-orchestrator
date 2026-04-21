// <copyright file="RecordingSink.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Concurrent;

namespace AiOrchestrator.Agent.Tests.Fakes;

/// <summary>Records every event received by an <see cref="IAgentEventSink"/> consumer.</summary>
public sealed class RecordingSink : IAgentEventSink
{
    /// <summary>Gets the session ids observed.</summary>
    public ConcurrentQueue<string> SessionIds { get; } = new();

    /// <summary>Gets every stats snapshot observed.</summary>
    public ConcurrentQueue<AgentStats> StatsUpdates { get; } = new();

    /// <summary>Gets task-complete events observed.</summary>
    public ConcurrentQueue<string> TaskCompletes { get; } = new();

    /// <summary>Gets pressure transitions observed.</summary>
    public ConcurrentQueue<(ContextPressureLevel Level, double Fraction)> Pressures { get; } = new();

    /// <summary>Gets raw lines observed.</summary>
    public ConcurrentQueue<LineEmitted> RawLines { get; } = new();

    /// <inheritdoc/>
    public ValueTask OnSessionIdAsync(string sessionId, CancellationToken ct)
    {
        this.SessionIds.Enqueue(sessionId);
        return ValueTask.CompletedTask;
    }

    /// <inheritdoc/>
    public ValueTask OnStatsAsync(AgentStats stats, CancellationToken ct)
    {
        this.StatsUpdates.Enqueue(stats);
        return ValueTask.CompletedTask;
    }

    /// <inheritdoc/>
    public ValueTask OnTaskCompleteAsync(string finalResponse, CancellationToken ct)
    {
        this.TaskCompletes.Enqueue(finalResponse);
        return ValueTask.CompletedTask;
    }

    /// <inheritdoc/>
    public ValueTask OnContextPressureAsync(ContextPressureLevel level, double fractionUsed, CancellationToken ct)
    {
        this.Pressures.Enqueue((level, fractionUsed));
        return ValueTask.CompletedTask;
    }

    /// <inheritdoc/>
    public ValueTask OnRawLineAsync(LineEmitted line, CancellationToken ct)
    {
        this.RawLines.Enqueue(line);
        return ValueTask.CompletedTask;
    }
}
