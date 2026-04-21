// <copyright file="ChainVerifier.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Audit.Chain;
using AiOrchestrator.Audit.Crypto;

namespace AiOrchestrator.Audit.Trust;

/// <summary>
/// Verifies a sequence of audit segments against the install anchor (TRUST-ROOT-1),
/// observed release manifests (TRUST-ROOT-2), and key transitions (KEY-ROT-1).
/// </summary>
public sealed class ChainVerifier
{
    private readonly InstallAnchor anchor;
    private readonly IReadOnlyList<ReleaseManifest> manifests;
    private readonly IReadOnlyList<KeyTransition> transitions;
    private readonly IClock clock;
    private readonly Ed25519Signer signer;
    private readonly KeyTransitionWriter txWriter;
    private readonly ITransparencyLog? transparencyLog;

    /// <summary>Initializes a new <see cref="ChainVerifier"/>.</summary>
    /// <param name="anchor">Install-time trust anchor.</param>
    /// <param name="manifests">Observed signed release manifests, ordered oldest-first.</param>
    /// <param name="transitions">Known key transitions, ordered oldest-first.</param>
    /// <param name="clock">Clock used for diagnostic timestamps.</param>
    /// <param name="transparencyLog">Optional transparency log consulted in <see cref="VerifyMode.Strict"/>.</param>
    public ChainVerifier(
        InstallAnchor anchor,
        IReadOnlyList<ReleaseManifest> manifests,
        IReadOnlyList<KeyTransition> transitions,
        IClock clock,
        ITransparencyLog? transparencyLog = null)
    {
        this.anchor = anchor ?? throw new ArgumentNullException(nameof(anchor));
        this.manifests = manifests ?? throw new ArgumentNullException(nameof(manifests));
        this.transitions = transitions ?? throw new ArgumentNullException(nameof(transitions));
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.signer = new Ed25519Signer();
        this.txWriter = new KeyTransitionWriter(this.signer);
        this.transparencyLog = transparencyLog;
    }

    /// <summary>Verifies a sequence of segments end-to-end.</summary>
    /// <param name="segments">Ordered (oldest-first) segments to verify.</param>
    /// <param name="mode">Verification depth.</param>
    /// <returns>The verification result.</returns>
    public ChainVerification Verify(IReadOnlyList<Segment> segments, VerifyMode mode)
    {
        ArgumentNullException.ThrowIfNull(segments);

        // Build the trusted-key set: install anchor + every manifest's keys + every transition's new key
        // (only when the transition has a valid cross-signature).
        var trustedFingerprints = new HashSet<string>(StringComparer.Ordinal)
        {
            FingerprintHex(this.anchor.InitialAuditPubKey),
        };

        foreach (var manifest in this.manifests)
        {
            foreach (var pk in manifest.TrustedAuditPubKeys)
            {
                trustedFingerprints.Add(FingerprintHex(pk));
            }
        }

        foreach (var tx in this.transitions)
        {
            if (!this.txWriter.VerifyCrossSignature(tx))
            {
                // INV-3 — a transition without a valid cross-signature does NOT extend trust.
                return new ChainVerification
                {
                    Ok = false,
                    Reason = ChainBreakReason.AuditChainKeyTransitionMissingCrossSignature,
                    Detail = $"KeyTransition {tx.OldKeyId}->{tx.NewKeyId} cross-signature failed.",
                };
            }

            // The retiring key must already be trusted before we accept the new key.
            if (trustedFingerprints.Contains(FingerprintHex(tx.OldPubKey)))
            {
                trustedFingerprints.Add(FingerprintHex(tx.NewPubKey));
            }
        }

        var prevHmac = new byte[32];
        long? prevSeq = null;
        Guid? prevSegmentId = null;

        for (var i = 0; i < segments.Count; i++)
        {
            var seg = segments[i];

            // INV-12 — monotonic sequence.
            if (prevSeq.HasValue && seg.Header.SegmentSeq != prevSeq.Value + 1)
            {
                return new ChainVerification
                {
                    Ok = false,
                    Reason = ChainBreakReason.AuditChainSegmentSeqRegression,
                    SegmentId = seg.Header.SegmentId,
                    Detail = $"Expected seq {prevSeq.Value + 1}, got {seg.Header.SegmentSeq}.",
                };
            }

            // INV-1 — chain HMAC must match.
            if (!seg.Header.PrevSegmentHmac.AsSpan().SequenceEqual(prevHmac))
            {
                return new ChainVerification
                {
                    Ok = false,
                    Reason = ChainBreakReason.AuditChainHmacMismatch,
                    SegmentId = seg.Header.SegmentId,
                    Detail = "Header.PrevSegmentHmac does not match the previous segment's HMAC.",
                };
            }

            if (prevSegmentId != seg.Header.PrevSegmentId)
            {
                return new ChainVerification
                {
                    Ok = false,
                    Reason = ChainBreakReason.AuditChainHmacMismatch,
                    SegmentId = seg.Header.SegmentId,
                    Detail = "Header.PrevSegmentId does not match the previous segment's id.",
                };
            }

            // Recompute body bytes and HMAC, verify.
            var body = SegmentCodec.SerializeBody(seg.Header, seg.Records);
            using (var h = new HMACSHA256(prevHmac))
            {
                var computed = h.ComputeHash(body);
                if (!computed.AsSpan().SequenceEqual(seg.Hmac))
                {
                    return new ChainVerification
                    {
                        Ok = false,
                        Reason = ChainBreakReason.AuditChainHmacMismatch,
                        SegmentId = seg.Header.SegmentId,
                        Detail = "Recomputed HMAC differs from stored HMAC.",
                    };
                }
            }

            // INV-2 — Ed25519 signature must verify under embedded pubkey.
            var combined = new byte[body.Length + seg.Hmac.Length];
            Buffer.BlockCopy(body, 0, combined, 0, body.Length);
            Buffer.BlockCopy(seg.Hmac, 0, combined, body.Length, seg.Hmac.Length);
            var hash = SHA256.HashData(combined);
            if (!this.signer.Verify(hash, seg.Ed25519Signature, seg.EmbeddedPublicKey))
            {
                return new ChainVerification
                {
                    Ok = false,
                    Reason = ChainBreakReason.AuditChainSignatureMismatch,
                    SegmentId = seg.Header.SegmentId,
                    Detail = "Ed25519 signature verification failed.",
                };
            }

            // Embedded pubkey fingerprint must match header's recorded fingerprint.
            var actualFp = SHA256.HashData(seg.EmbeddedPublicKey);
            if (!actualFp.AsSpan().SequenceEqual(seg.Header.SignerPubKeyFingerprint))
            {
                return new ChainVerification
                {
                    Ok = false,
                    Reason = ChainBreakReason.AuditChainSignatureMismatch,
                    SegmentId = seg.Header.SegmentId,
                    Detail = "Header signer fingerprint does not match embedded public key.",
                };
            }

            // TRUST-ROOT-1/2 — signer must be in the trusted set.
            var signerFp = FingerprintHex(seg.EmbeddedPublicKey);
            if (!trustedFingerprints.Contains(signerFp))
            {
                var reason = i == 0
                    ? ChainBreakReason.AuditChainBrokenAtInstallAnchor
                    : ChainBreakReason.AuditChainBrokenAtReleaseManifest;
                return new ChainVerification
                {
                    Ok = false,
                    Reason = reason,
                    SegmentId = seg.Header.SegmentId,
                    Detail = $"Signer key '{seg.Header.SignerKeyId}' is not trusted by anchor or any manifest.",
                };
            }

            // TRUST-ROOT-6 — strict mode consults transparency log.
            if (mode == VerifyMode.Strict)
            {
                if (this.transparencyLog is null)
                {
                    return new ChainVerification
                    {
                        Ok = false,
                        Reason = ChainBreakReason.AuditChainTransparencyLogMismatch,
                        SegmentId = seg.Header.SegmentId,
                        Detail = "Strict verify requested but no transparency log was supplied.",
                    };
                }

                var bodyHash = SHA256.HashData(body);
                if (!this.transparencyLog.Contains(bodyHash, seg.Ed25519Signature))
                {
                    return new ChainVerification
                    {
                        Ok = false,
                        Reason = ChainBreakReason.AuditChainTransparencyLogMismatch,
                        SegmentId = seg.Header.SegmentId,
                        Detail = "Segment not present in transparency log.",
                    };
                }
            }

            prevHmac = seg.Hmac;
            prevSeq = seg.Header.SegmentSeq;
            prevSegmentId = seg.Header.SegmentId;
        }

        _ = this.clock.UtcNow; // touch the clock so it is part of the audit-time decision surface
        return new ChainVerification { Ok = true };
    }

    private static string FingerprintHex(byte[] pubKey)
    {
        var h = SHA256.HashData(pubKey);
        return Convert.ToHexString(h);
    }
}
