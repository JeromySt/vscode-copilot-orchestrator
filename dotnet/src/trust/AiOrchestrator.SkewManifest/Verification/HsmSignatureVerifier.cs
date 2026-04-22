// <copyright file="HsmSignatureVerifier.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Security.Cryptography;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.SkewManifest.Verification;

/// <summary>
/// Verifies that a <see cref="SkewManifest"/> carries at least M valid ECDSA P-256 signatures
/// from the configured burn-in HSM set (INV-4, INV-5). Verifier-only; never signs (INV-10).
/// </summary>
internal sealed class HsmSignatureVerifier
{

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
            if (!string.Equals(sig.Algorithm, "ECDSA-P256", System.StringComparison.Ordinal))
            {
                failureDetail = $"Unsupported algorithm: {sig.Algorithm}";
                continue;
            }

            var matched = false;
            foreach (var pub in options.KnownHsmPublicKeys)
            {
                try
                {
                    using var ecdsa = System.Security.Cryptography.ECDsa.Create();
                    ecdsa.ImportSubjectPublicKeyInfo(pub, out _);
                    if (ecdsa.VerifyData(payload, sig.Signature, System.Security.Cryptography.HashAlgorithmName.SHA256))
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
                catch (System.Security.Cryptography.CryptographicException)
                {
                    continue;
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
