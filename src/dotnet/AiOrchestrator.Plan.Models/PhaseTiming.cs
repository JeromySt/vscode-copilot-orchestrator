// <copyright file="PhaseTiming.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Plan.Models;

/// <summary>Records the start and completion times for a single execution phase.</summary>
public sealed record PhaseTiming
{
    /// <summary>Gets when the phase completed, or <see langword="null"/> if it has not yet finished.</summary>
    public DateTimeOffset? CompletedAt { get; init; }

    /// <summary>Gets the name of the execution phase (e.g. <c>merge-fi</c>, <c>work</c>, <c>commit</c>).</summary>
    public string Phase { get; init; } = string.Empty;

    /// <summary>Gets when the phase began, or <see langword="null"/> if it has not yet started.</summary>
    public DateTimeOffset? StartedAt { get; init; }
}
