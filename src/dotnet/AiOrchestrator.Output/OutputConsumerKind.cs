// <copyright file="OutputConsumerKind.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Output;

/// <summary>Kinds of standard fan-out consumers attached to a job's output streams.</summary>
public enum OutputConsumerKind
{
    /// <summary>Durable event log sink (<see cref="AiOrchestrator.Abstractions.Eventing.IEventStore"/>).</summary>
    EventLog,

    /// <summary>Incremental line projector for UI / TUI rendering.</summary>
    LineView,

    /// <summary>Bounded ring buffer used for snapshot reattach.</summary>
    RingBuffer,

    /// <summary>Structured logger sink.</summary>
    Logger,
}
