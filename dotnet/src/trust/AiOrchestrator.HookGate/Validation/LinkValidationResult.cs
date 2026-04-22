// <copyright file="LinkValidationResult.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.HookGate.Validation;

/// <summary>Outcome of <see cref="LinkValidator.ValidateAsync"/>.</summary>
public sealed record LinkValidationResult
{
    /// <summary>Gets a value indicating whether the link passed all tamper checks (HK-GATE-LINK-3 v1.4).</summary>
    public required bool Ok { get; init; }

    /// <summary>Gets a short reason string on failure (e.g., <c>st_nlink&gt;1</c>, <c>reparse-point outside worktree</c>).</summary>
    public required string? FailureReason { get; init; }
}
