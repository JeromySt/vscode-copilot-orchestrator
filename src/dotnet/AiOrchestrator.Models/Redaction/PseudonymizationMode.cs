// <copyright file="PseudonymizationMode.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Models.Redaction;

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
