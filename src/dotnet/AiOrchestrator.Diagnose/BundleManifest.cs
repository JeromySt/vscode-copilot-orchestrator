// <copyright file="BundleManifest.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;

namespace AiOrchestrator.Diagnose;

/// <summary>The root <c>manifest.json</c> document describing the bundle contents.</summary>
public sealed class BundleManifest
{
    /// <summary>Gets the manifest schema version. Current version is <c>1.0</c>.</summary>
    public required Version SchemaVersion { get; init; }

    /// <summary>Gets the UTC time the bundle was produced.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets the pseudonymization mode used.</summary>
    public required PseudonymizationMode PseudonymizationMode { get; init; }

    /// <summary>Gets the recipient fingerprint bound to the encrypted mapping (when mode is <see cref="PseudonymizationMode.Reversible"/>).</summary>
    public required string? RecipientPubKeyFingerprint { get; init; }

    /// <summary>Gets the per-entry metadata, keyed by the archive-relative path.</summary>
    public required ImmutableDictionary<string, BundleEntry> Entries { get; init; }

    /// <summary>Gets the .NET runtime version recorded at bundle time.</summary>
    public required string DotnetRuntimeVersion { get; init; }

    /// <summary>Gets the AIO version recorded at bundle time.</summary>
    public required string AioVersion { get; init; }

    /// <summary>Gets any non-fatal warnings emitted during bundle production (e.g. <c>allow-pii</c>, <c>process-env-included</c>).</summary>
    public IReadOnlyList<string> Warnings { get; init; } = Array.Empty<string>();
}
