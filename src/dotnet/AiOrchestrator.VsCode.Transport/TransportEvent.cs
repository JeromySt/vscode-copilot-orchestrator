// <copyright file="TransportEvent.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Text.Json;

namespace AiOrchestrator.VsCode.Transport;

/// <summary>
/// A single event multiplexed from the orchestrator onto a
/// <see cref="TransportSession"/>'s event stream (INV-4).
/// </summary>
public sealed record TransportEvent
{
    /// <summary>Gets the event category (e.g. <c>plan.progress</c>, <c>job.state</c>, <c>log</c>).</summary>
    public required string Kind { get; init; }

    /// <summary>Gets the event payload encoded as a JSON element.</summary>
    public required JsonElement Payload { get; init; }

    /// <summary>Gets the wall-clock time at which the event was emitted.</summary>
    public required DateTimeOffset At { get; init; }
}
