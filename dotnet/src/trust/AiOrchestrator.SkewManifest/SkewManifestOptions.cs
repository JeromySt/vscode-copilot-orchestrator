// <copyright file="SkewManifestOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;

namespace AiOrchestrator.SkewManifest;

/// <summary>Bind-time options for the <see cref="SkewManifestObserver"/>.</summary>
public sealed record SkewManifestOptions
{
    /// <summary>Gets the HTTPS URL from which the signed manifest is fetched (INV-1).</summary>
    public string ManifestUrl { get; init; } = "https://aka.ms/aio-build-keys.json";

    /// <summary>Gets the interval at which the observer re-fetches the manifest.</summary>
    public TimeSpan PollInterval { get; init; } = TimeSpan.FromHours(6);

    /// <summary>Gets the staleness threshold after which a <c>SkewManifestStale</c> event fires (INV-3).</summary>
    public TimeSpan StaleAfter { get; init; } = TimeSpan.FromDays(30);

    /// <summary>Gets the minimum number of valid HSM signatures required (M-of-N, default 3).</summary>
    public int RequiredHsmSignatures { get; init; } = 3;

    /// <summary>Gets the burn-in HSM public keys (N=5 by default); indexed by order (INV-5).</summary>
    public ImmutableArray<byte[]> KnownHsmPublicKeys { get; init; } = ImmutableArray<byte[]>.Empty;

    /// <summary>Gets the emergency-revocation HSM public keys, air-gapped from the primary set (INV-7).</summary>
    public ImmutableArray<byte[]> EmergencyRevocationPublicKeys { get; init; } = ImmutableArray<byte[]>.Empty;

    /// <summary>Gets the Sigstore-style transparency log URL; when <see langword="null"/> the check is skipped.</summary>
    public string? TransparencyLogUrl { get; init; }
}
