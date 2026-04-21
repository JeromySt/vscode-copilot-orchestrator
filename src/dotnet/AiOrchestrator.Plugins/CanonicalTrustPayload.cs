// <copyright file="CanonicalTrustPayload.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Plugins.Trust;

namespace AiOrchestrator.Plugins;

/// <summary>A canonical trust payload used for Ed25519 signature computation (Ed25519 covers this, not the full TrustFile).</summary>
/// <param name="TrustedPlugins">The list of trusted plugins.</param>
/// <param name="SignedAt">The signing timestamp.</param>
/// <param name="SignerKeyId">The signer key identifier.</param>
internal sealed record CanonicalTrustPayload(
    ImmutableArray<TrustedPlugin> TrustedPlugins,
    DateTimeOffset SignedAt,
    string SignerKeyId);
