// <copyright file="PortabilityOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Plan.Portability;

/// <summary>Options controlling plan portability (export/import) per §3.20.</summary>
public sealed record PortabilityOptions
{
    /// <summary>Gets the schema version for produced archives. Mismatches on import raise <see cref="PortabilitySchemaMismatchException"/>.</summary>
    public Version SchemaVersion { get; init; } = new Version(1, 0);

    /// <summary>Gets the AIO version recorded in the manifest.</summary>
    public string AioVersion { get; init; } = "0.1.0";
}
