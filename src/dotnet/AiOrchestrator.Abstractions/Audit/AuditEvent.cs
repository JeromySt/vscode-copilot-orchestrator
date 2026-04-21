// <copyright file="AuditEvent.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Abstractions.Audit;

/// <summary>An immutable record of a security-relevant action for the audit trail.</summary>
/// <param name="EventId">Unique identifier for this audit event.</param>
/// <param name="OccurredAtUtc">The UTC time at which the event occurred.</param>
/// <param name="PrincipalId">The identifier of the principal who performed the action.</param>
/// <param name="Action">A short identifier for the action type (e.g., <c>plan.created</c>, <c>credential.accessed</c>).</param>
/// <param name="ResourceId">The identifier of the resource affected by the action, if applicable.</param>
/// <param name="Outcome">Indicates whether the action succeeded, failed, or was denied.</param>
/// <param name="Details">Optional structured JSON string containing additional context about the event.</param>
/// <param name="ChainHash">The hash linking this event to the preceding event, enabling chain verification.</param>
public sealed record AuditEvent(
    Guid EventId,
    DateTimeOffset OccurredAtUtc,
    string PrincipalId,
    string Action,
    string? ResourceId,
    AuditOutcome Outcome,
    string? Details,
    string? ChainHash);

/// <summary>Describes the outcome of an audited action.</summary>
public enum AuditOutcome
{
    /// <summary>The action completed successfully.</summary>
    Success,

    /// <summary>The action failed due to an error.</summary>
    Failure,

    /// <summary>The action was denied by an authorization policy.</summary>
    Denied,
}
