// <copyright file="SegmentHeader.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using AiOrchestrator.Audit.Trust;

namespace AiOrchestrator.Audit.Chain;

/// <summary>Header carried at the start of every segment file. Embeds the data needed for offline verification.</summary>
public sealed record SegmentHeader
{
    /// <summary>Gets the unique identifier for this segment.</summary>
    public required Guid SegmentId { get; init; }

    /// <summary>Gets the previous segment's identifier, or <see langword="null"/> for the first segment.</summary>
    public required Guid? PrevSegmentId { get; init; }

    /// <summary>Gets the previous segment's HMAC (32 zero bytes for the first segment).</summary>
    public required byte[] PrevSegmentHmac { get; init; }

    /// <summary>Gets the SHA-256 fingerprint of the public key used to sign this segment.</summary>
    public required byte[] SignerPubKeyFingerprint { get; init; }

    /// <summary>Gets the human-readable identifier of the signer's key (e.g., <c>install</c>, <c>v2</c>).</summary>
    public required string SignerKeyId { get; init; }

    /// <summary>Gets the wall-clock instant at which this segment was created.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets the monotonic sequence number of this segment within the audit log (INV-12).</summary>
    public required long SegmentSeq { get; init; }

    /// <summary>Gets references to key transitions effective when this segment was sealed.</summary>
    public required ImmutableArray<KeyTransitionRef> EffectiveTransitions { get; init; }
}

/// <summary>A pointer to a <see cref="KeyTransition"/> identified by old/new key IDs.</summary>
/// <param name="OldKeyId">The retiring key identifier.</param>
/// <param name="NewKeyId">The replacement key identifier.</param>
public sealed record KeyTransitionRef(string OldKeyId, string NewKeyId);
