// <copyright file="CanonicalPayload.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text;
using System.Text.Json;

namespace AiOrchestrator.SkewManifest.Verification;

/// <summary>
/// Produces the canonical byte sequence that HSMs sign: a deterministic JSON
/// serialization of the manifest payload with <see cref="SkewManifest.HsmSignatures"/>
/// and <see cref="SkewManifest.TransparencyLogProof"/> stripped (since those are
/// applied after signing).
/// </summary>
internal static class CanonicalPayload
{
    private static readonly JsonSerializerOptions Opts = new()
    {
        WriteIndented = false,
    };

    public static byte[] ComputeForSignature(SkewManifest mfst)
    {
        var stripped = mfst with
        {
            HsmSignatures = System.Collections.Immutable.ImmutableArray<HsmSignature>.Empty,
            TransparencyLogProof = null,
            EmergencyRevocation = mfst.EmergencyRevocation is null
                ? null
                : mfst.EmergencyRevocation with
                {
                    AdditionalSignatures = System.Collections.Immutable.ImmutableArray<HsmSignature>.Empty,
                },
        };
        return Encoding.UTF8.GetBytes(JsonSerializer.Serialize(stripped, Opts));
    }

    public static byte[] ComputeForEmergencyRevocationSignature(EmergencyRevocation revocation)
    {
        var stripped = revocation with
        {
            AdditionalSignatures = System.Collections.Immutable.ImmutableArray<HsmSignature>.Empty,
        };
        return Encoding.UTF8.GetBytes(JsonSerializer.Serialize(stripped, Opts));
    }
}
