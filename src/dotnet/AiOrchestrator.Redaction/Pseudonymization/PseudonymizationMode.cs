// <copyright file="PseudonymizationMode.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Redaction.Pseudonymization;

/// <summary>Controls how detected paths and session identifiers are replaced.</summary>
public enum PseudonymizationMode
{
    /// <summary>Matched values are replaced with a static <c>[REDACTED]</c> marker.</summary>
    Off = 0,

    /// <summary>
    /// Matched values are replaced with a deterministic, per-bundle pseudonym derived from
    /// SHA-256(bundleSalt ∥ value).  No reverse-mapping is stored (INV-7).
    /// </summary>
    Anonymous = 1,

    /// <summary>
    /// Matched values are replaced with a pseudonym and the real value is stored in an
    /// encrypted reverse-mapping table (RSA-OAEP-SHA-256) so the original can be recovered.
    /// </summary>
    Reversible = 2,
}
