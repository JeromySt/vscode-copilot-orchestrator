// <copyright file="AuditChainResult.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Abstractions.Audit;

/// <summary>The result of verifying the integrity of the audit event chain.</summary>
/// <param name="IsValid">Whether the entire chain is intact and unmodified.</param>
/// <param name="EventsVerified">The total number of events that were examined during verification.</param>
/// <param name="FirstBrokenSequence">The sequence number of the first event where chain integrity was broken, or <see langword="null"/> if the chain is valid.</param>
/// <param name="ErrorMessage">A human-readable description of the integrity violation, if any.</param>
public sealed record AuditChainResult(
    bool IsValid,
    long EventsVerified,
    long? FirstBrokenSequence,
    string? ErrorMessage);
