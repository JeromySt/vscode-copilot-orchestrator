// <copyright file="ChainVerification.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Audit.Trust;

/// <summary>The result of verifying a sequence of audit segments.</summary>
public sealed record ChainVerification
{
    /// <summary>Gets a value indicating whether the chain is intact.</summary>
    public bool Ok { get; init; }

    /// <summary>Gets the reason the chain was rejected, when <see cref="Ok"/> is <see langword="false"/>.</summary>
    public ChainBreakReason? Reason { get; init; }

    /// <summary>Gets the identifier of the segment at which the chain broke.</summary>
    public Guid? SegmentId { get; init; }

    /// <summary>Gets a human-readable diagnostic explaining the break.</summary>
    public string? Detail { get; init; }
}

/// <summary>The categorical reason a <see cref="ChainVerification"/> failed.</summary>
public enum ChainBreakReason
{
    /// <summary>No path of trust connects the first segment to the install anchor (TRUST-ROOT-1).</summary>
    AuditChainBrokenAtInstallAnchor,

    /// <summary>A segment's signing key is not trusted by any release manifest.</summary>
    AuditChainBrokenAtReleaseManifest,

    /// <summary>A release manifest is not signed by the offline root.</summary>
    AuditChainBrokenAtOfflineRoot,

    /// <summary>A segment's recomputed HMAC does not match the embedded value.</summary>
    AuditChainHmacMismatch,

    /// <summary>A segment's Ed25519 signature does not verify.</summary>
    AuditChainSignatureMismatch,

    /// <summary>A key transition is missing the required cross-signature (INV-3).</summary>
    AuditChainKeyTransitionMissingCrossSignature,

    /// <summary>Strict mode: a segment is not present in the transparency log (TRUST-ROOT-6).</summary>
    AuditChainTransparencyLogMismatch,

    /// <summary>The segment sequence number is non-monotonic or has a gap (INV-12).</summary>
    AuditChainSegmentSeqRegression,
}

/// <summary>Selects how exhaustively <see cref="ChainVerifier"/> verifies a chain.</summary>
public enum VerifyMode
{
    /// <summary>Verify HMAC, signatures, transitions, and trust anchors only.</summary>
    Standard,

    /// <summary>In addition to <see cref="Standard"/>, consult a Sigstore-style transparency log.</summary>
    Strict,
}
