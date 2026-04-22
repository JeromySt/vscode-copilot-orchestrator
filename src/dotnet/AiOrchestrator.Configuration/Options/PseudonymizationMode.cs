// <copyright file="PseudonymizationMode.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Configuration.Options;

/// <summary>Pseudonymization level used when collecting diagnostic data.</summary>
public enum PseudonymizationMode
{
    /// <summary>All user-identifying fields are removed.</summary>
    Anonymous,

    /// <summary>User-identifying fields are replaced with stable pseudonyms.</summary>
    Pseudonymized,

    /// <summary>User-identifying fields are retained as-is (requires explicit opt-in).</summary>
    Full,
}
