// <copyright file="LineEmitted.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Agent;

/// <summary>Identifies which stdio stream produced a line.</summary>
public enum AgentStream
{
    /// <summary>Standard output.</summary>
    Stdout,

    /// <summary>Standard error.</summary>
    Stderr,
}

/// <summary>
/// Represents one complete line read from the agent process, fed to the handler pipeline.
/// Stand-in until job 15 delivers the shared <c>LineProjector</c> typed sink.
/// </summary>
public sealed record LineEmitted
{
    /// <summary>Gets the stream the line came from.</summary>
    public required AgentStream Stream { get; init; }

    /// <summary>Gets the decoded UTF-8 text of the line (no trailing newline).</summary>
    public required string Line { get; init; }

    /// <summary>Gets the monotonic timestamp (milliseconds) at which the line was read.</summary>
    public long MonotonicMs { get; init; }
}
