// <copyright file="OperationResult.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Plan.Reshape;

/// <summary>Outcome of a single <see cref="ReshapeOperation"/> inside a batch.</summary>
public sealed record OperationResult
{
    /// <summary>Gets the operation that was attempted.</summary>
    public required ReshapeOperation Op { get; init; }

    /// <summary>Gets a value indicating whether the operation validated successfully.</summary>
    public required bool Success { get; init; }

    /// <summary>Gets a short machine-readable failure reason when <see cref="Success"/> is false.</summary>
    public required string? FailureReason { get; init; }

    /// <summary>Gets the job id affected by this op when applicable.</summary>
    public required JobId? AffectedJobId { get; init; }
}
