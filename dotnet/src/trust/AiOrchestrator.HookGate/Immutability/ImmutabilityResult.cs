// <copyright file="ImmutabilityResult.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.HookGate.Immutability;

/// <summary>Outcome of an attempt to apply best-effort immutability (HK-GATE-LINK-2 v1.4).</summary>
public sealed record ImmutabilityResult
{
    /// <summary>Gets a value indicating whether immutability was successfully applied.</summary>
    public required bool Supported { get; init; }

    /// <summary>Gets the underlying mechanism attempted (chattr, chflags, DACL-deny).</summary>
    public required string Mechanism { get; init; }

    /// <summary>Gets the reason for failure, or <see langword="null"/> on success.</summary>
    public required string? FailureReason { get; init; }
}
