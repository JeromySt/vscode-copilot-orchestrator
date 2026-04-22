// <copyright file="CeremonyRequest.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Tools.KeyCeremony;

/// <summary>Inputs to a key-signing ceremony invocation.</summary>
public sealed record CeremonyRequest
{
    /// <summary>Gets the path to the unsigned release manifest.</summary>
    public required AbsolutePath UnsignedManifestPath { get; init; }

    /// <summary>Gets the destination path for the signed release manifest.</summary>
    public required AbsolutePath OutputSignedPath { get; init; }

    /// <summary>Gets the operators (M of N) required to sign the manifest.</summary>
    public required ImmutableArray<HsmOperatorId> RequiredSigners { get; init; }

    /// <summary>Gets the file path the ceremony transcript is written to (separate from the signed manifest).</summary>
    public required string CeremonyTranscriptPath { get; init; }

    /// <summary>Gets a value indicating whether to submit the signed manifest to a transparency log.</summary>
    public bool SubmitToTransparencyLog { get; init; } = true;

    /// <summary>Gets the optional transparency-log URL.</summary>
    public string? TransparencyLogUrl { get; init; }

    /// <summary>Gets a value indicating whether the ceremony may run with network interfaces up.</summary>
    public bool AllowNetwork { get; init; }
}
