// <copyright file="AuditOutcome.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Abstractions.Audit;

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
