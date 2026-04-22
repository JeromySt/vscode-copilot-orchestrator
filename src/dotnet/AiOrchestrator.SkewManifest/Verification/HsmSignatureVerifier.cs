// <copyright file="HsmSignatureVerifier.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using Microsoft.Extensions.Options;
using Org.BouncyCastle.Math.EC.Rfc8032;

namespace AiOrchestrator.SkewManifest.Verification;

/// <summary>
/// Verifies that a <see cref="SkewManifest"/> carries at least M valid Ed25519 signatures
/// from the configured burn-in HSM set (INV-4, INV-5). Verifier-only; never signs (INV-10).
/// </summary>
internal sealed class HsmSignatureVerifier
{
    private const int Ed25519PublicKeySize = 32;
    private const int Ed25519SignatureSize = 64;

    private readonly IOptionsMonitor<SkewManifestOptions> opts;

    public HsmSignatureVerifier(IOptionsMonitor<SkewManifestOptions> opts)
    {
        this.opts = opts;
    }

    public bool TryVerify(SkewManifest mfst, out int validCount, out string? failureDetail)
    {
        var options = this.opts.CurrentValue;
        validCount = 0;
        failureDetail = null;

        var payload = CanonicalPayload.ComputeForSignature(mfst);

        // Track which pubkeys already verified to prevent double-counting.
        var seenPubKeys = new HashSet<string>(System.StringComparer.Ordinal);

        foreach (var sig in mfst.HsmSignatures)
        {
            if (!string.Equals(sig.Algorithm, "Ed25519", System.StringComparison.Ordinal))
            {
                failureDetail = $"Unsupported algorithm: {sig.Algorithm}";
                continue;
            }

            var matched = false;
            foreach (var pub in options.KnownHsmPublicKeys)
            {
                if (pub.Length != Ed25519PublicKeySize)
                {
                    continue;
                }

                if (sig.Signature.Length != Ed25519SignatureSize)
                {
                    continue;
                }

                if (Ed25519.Verify(sig.Signature, 0, pub, 0, payload, 0, payload.Length))
                {
                    var fp = System.Convert.ToHexString(pub);
                    if (seenPubKeys.Add(fp))
                    {
                        validCount++;
                    }

                    matched = true;
                    break;
                }
            }

            if (!matched)
            {
                failureDetail ??= $"HSM '{sig.HsmId}' signature did not match any known key.";
            }
        }

        return validCount >= options.RequiredHsmSignatures;
    }
}
