// <copyright file="Segment.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace AiOrchestrator.Audit.Chain;

/// <summary>An immutable, signed unit of audit records persisted as one file on disk.</summary>
public sealed class Segment
{
    /// <summary>Gets the segment header.</summary>
    public required SegmentHeader Header { get; init; }

    /// <summary>Gets the records contained in this segment.</summary>
    public required ImmutableArray<AuditRecord> Records { get; init; }

    /// <summary>Gets the HMAC chain value for this segment (32 bytes).</summary>
    public required byte[] Hmac { get; init; }

    /// <summary>Gets the Ed25519 signature over the segment body + HMAC (64 bytes).</summary>
    public required byte[] Ed25519Signature { get; init; }

    /// <summary>Gets the embedded public key used to verify <see cref="Ed25519Signature"/>.</summary>
    public required byte[] EmbeddedPublicKey { get; init; }
}
