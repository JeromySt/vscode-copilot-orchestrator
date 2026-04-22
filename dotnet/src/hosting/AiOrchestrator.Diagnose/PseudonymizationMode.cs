// <copyright file="PseudonymizationMode.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Diagnose;

/// <summary>Controls how sensitive identifiers are treated when building a diagnose bundle.</summary>
public enum PseudonymizationMode
{
    /// <summary>No pseudonymization is applied — raw identifiers are preserved. Requires explicit opt-in (<c>--allow-pii</c>).</summary>
    Off,

    /// <summary>Sensitive identifiers are replaced with stable, non-reversible pseudonyms.</summary>
    Anonymous,

    /// <summary>Sensitive identifiers are replaced with stable pseudonyms plus an encrypted reversible mapping for the configured recipient.</summary>
    Reversible,
}
