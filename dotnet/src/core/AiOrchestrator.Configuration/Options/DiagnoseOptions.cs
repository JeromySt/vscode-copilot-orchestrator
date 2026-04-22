// <copyright file="DiagnoseOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Configuration.Options;

/// <summary>Diagnostics collection options.</summary>
public sealed class DiagnoseOptions
{
    /// <summary>Gets or sets the pseudonymization mode applied to diagnostic data.</summary>
    public PseudonymizationMode Pseudonymize { get; set; } = PseudonymizationMode.Anonymous;
}
