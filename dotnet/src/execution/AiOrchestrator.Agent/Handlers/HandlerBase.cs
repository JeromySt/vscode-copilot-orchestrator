// <copyright file="HandlerBase.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Time;

namespace AiOrchestrator.Agent.Handlers;

/// <summary>Base class for per-line handlers (session id, stats, done, context pressure).</summary>
internal abstract class HandlerBase
{
    /// <summary>Initializes a new instance of the <see cref="HandlerBase"/> class.</summary>
    /// <param name="clock">Clock for elapsed-time attribution.</param>
    protected HandlerBase(IClock clock)
    {
        ArgumentNullException.ThrowIfNull(clock);
        this.Clock = clock;
    }

    /// <summary>Gets the clock.</summary>
    protected IClock Clock { get; }

    /// <summary>Tries to handle a line. Returns true when the line was recognized.</summary>
    /// <param name="line">The line to inspect.</param>
    /// <param name="spec">The current run spec (used for runner-specific knowledge).</param>
    /// <returns>True when consumed.</returns>
    public abstract bool TryHandle(LineEmitted line, AgentSpec spec);
}
