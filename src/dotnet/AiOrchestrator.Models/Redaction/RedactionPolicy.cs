// <copyright file="RedactionPolicy.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace AiOrchestrator.Models.Redaction;

/// <summary>Specifies which redaction rules apply and how pseudonymization is handled.</summary>
public sealed record RedactionPolicy
{
    /// <summary>Gets the set of rule identifiers that are enabled for this policy.</summary>
    public required ImmutableArray<string> EnabledRules { get; init; }

    /// <summary>Gets the pseudonymization mode for sensitive identifiers.</summary>
    public required PseudonymizationMode PseudonymizationMode { get; init; }
}

/// <summary>Controls how sensitive identifiers are pseudonymized during redaction.</summary>
public enum PseudonymizationMode
{
    /// <summary>No pseudonymization is applied.</summary>
    Off,

    /// <summary>Identifiers are replaced with anonymous tokens that cannot be reversed.</summary>
    Anonymous,

    /// <summary>Identifiers are replaced with tokens that can be reversed by an authorized party.</summary>
    Reversible,
}
