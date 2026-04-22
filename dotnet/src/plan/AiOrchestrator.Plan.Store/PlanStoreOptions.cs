// <copyright file="PlanStoreOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Plan.Store;

/// <summary>Tunable options for <see cref="PlanStore"/>.</summary>
public sealed record PlanStoreOptions
{
    /// <summary>Gets auto-checkpoint threshold: after this many journal mutations since the last checkpoint, one is taken.</summary>
    public int CheckpointAfterMutations { get; init; } = 100;

    /// <summary>Gets auto-checkpoint time threshold: after this interval since the last checkpoint, a new one is taken on the next mutation.</summary>
    public TimeSpan CheckpointAfterTime { get; init; } = TimeSpan.FromMinutes(5);
}
