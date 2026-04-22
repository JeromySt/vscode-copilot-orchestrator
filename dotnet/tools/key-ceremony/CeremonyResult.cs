// <copyright file="CeremonyResult.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Tools.KeyCeremony;

/// <summary>Outputs from a completed key-signing ceremony.</summary>
public sealed record CeremonyResult
{
    /// <summary>Gets the path to the produced signed manifest.</summary>
    public required AbsolutePath SignedManifestPath { get; init; }

    /// <summary>Gets the operators that actually signed.</summary>
    public required ImmutableArray<HsmOperatorId> ActualSigners { get; init; }

    /// <summary>Gets the receipt returned by the transparency log, if one was used.</summary>
    public required string? TransparencyLogReceipt { get; init; }

    /// <summary>Gets the path the ceremony transcript was written to.</summary>
    public required AbsolutePath TranscriptPath { get; init; }
}
