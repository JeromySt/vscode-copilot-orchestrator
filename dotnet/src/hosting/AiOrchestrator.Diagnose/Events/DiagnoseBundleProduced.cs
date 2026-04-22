// <copyright file="DiagnoseBundleProduced.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Diagnose.Events;

/// <summary>Event emitted when a diagnose bundle has been successfully produced (INV-6).</summary>
public sealed record DiagnoseBundleProduced
{
    /// <summary>Gets the plan captured, if any.</summary>
    public required PlanId? PlanId { get; init; }

    /// <summary>Gets the absolute output path of the produced bundle.</summary>
    public required string OutputPath { get; init; }

    /// <summary>Gets the lowercase hex SHA-256 of the serialized manifest.</summary>
    public required string ManifestSha256 { get; init; }

    /// <summary>Gets the pseudonymization mode used.</summary>
    public required PseudonymizationMode PseudonymizationMode { get; init; }

    /// <summary>Gets the recipient fingerprint, if the bundle is reversible.</summary>
    public required string? RecipientPubKeyFingerprint { get; init; }

    /// <summary>Gets the UTC time the bundle was produced.</summary>
    public required DateTimeOffset ProducedAt { get; init; }
}
