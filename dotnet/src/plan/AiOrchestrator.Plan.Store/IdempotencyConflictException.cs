// <copyright file="IdempotencyConflictException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Plan.Store;

/// <summary>
/// Thrown when an idempotency key is re-used for a different logical content (RW-2-IDEM-2).
/// Carries both the originally stored mutation and the conflicting new mutation for diagnosis.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1032:Implement standard exception constructors", Justification = "Required properties enforce correct diagnostic context.")]
public sealed class IdempotencyConflictException : Exception
{
    /// <summary>Initializes a new instance of the <see cref="IdempotencyConflictException"/> class.</summary>
    public IdempotencyConflictException()
        : base("Idempotency key already exists with different content.")
    {
    }

    /// <summary>Gets the duplicated idempotency key.</summary>
    public required IdempotencyKey Key { get; init; }

    /// <summary>Gets the mutation previously stored under <see cref="Key"/>.</summary>
    public required PlanMutation StoredMutation { get; init; }

    /// <summary>Gets the new mutation whose content differs from <see cref="StoredMutation"/>.</summary>
    public required PlanMutation NewMutation { get; init; }
}

/// <summary>Thrown when the journal on disk has missing or out-of-order sequence numbers (INV-8).</summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1032:Implement standard exception constructors", Justification = "Custom exception for corrupted-journal diagnostics.")]
public sealed class PlanJournalCorruptedException : Exception
{
    /// <summary>Initializes a new instance of the <see cref="PlanJournalCorruptedException"/> class.</summary>
    /// <param name="message">The diagnostic message describing the corruption.</param>
    public PlanJournalCorruptedException(string message)
        : base(message)
    {
    }
}
