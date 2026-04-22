// <copyright file="SkewManifestRejectionReason.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.SkewManifest;

/// <summary>Reasons a skew manifest may be rejected during verification.</summary>
public enum SkewManifestRejectionReason
{
    /// <summary>Fewer than <see cref="SkewManifestOptions.RequiredHsmSignatures"/> valid HSM signatures (INV-4).</summary>
    InsufficientSignatures,

    /// <summary>A signature was structurally invalid or did not verify.</summary>
    InvalidSignature,

    /// <summary>Manifest expired or was signed in the future beyond clock-skew tolerance (INV-2).</summary>
    ExpiredManifest,

    /// <summary>A newer manifest was previously seen than the one being verified (INV-6).</summary>
    VersionRegression,

    /// <summary>The transparency log could not confirm inclusion (INV-8).</summary>
    TransparencyLogMismatch,

    /// <summary>The carried <see cref="EmergencyRevocation"/> was not validly signed by the emergency set (INV-7).</summary>
    EmergencyRevocationInvalid,

    /// <summary>A signature referenced an HSM identifier that is not in the burn-in set (INV-5).</summary>
    UnknownHsmSigner,
}
