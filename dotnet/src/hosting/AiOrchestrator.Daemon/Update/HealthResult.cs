// <copyright file="HealthResult.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Daemon.Update;

/// <summary>Result of <see cref="HealthCheck.RunAsync"/>.</summary>
public sealed record HealthResult
{
    /// <summary>Gets a value indicating whether the post-update self-check succeeded.</summary>
    public required bool Ok { get; init; }

    /// <summary>Gets a human-readable failure reason when <see cref="Ok"/> is false.</summary>
    public required string? FailureReason { get; init; }
}
