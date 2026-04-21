// <copyright file="HmacChain.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Security.Cryptography;

namespace AiOrchestrator.Audit.Chain;

/// <summary>Computes the HMAC-SHA256 chain hash over a segment given the previous segment's HMAC (INV-1, INV-9).</summary>
public sealed class HmacChain
{
    /// <summary>Computes the HMAC for this segment, using the previous segment's HMAC as the key.</summary>
    /// <param name="prevHmac">The HMAC of the previous segment, or 32 zero bytes for the first segment.</param>
    /// <param name="segmentBytes">The serialized body of the current segment.</param>
    /// <returns>A 32-byte HMAC-SHA256 value.</returns>
    public byte[] Compute(byte[] prevHmac, ReadOnlySpan<byte> segmentBytes)
    {
        ArgumentNullException.ThrowIfNull(prevHmac);
        if (prevHmac.Length != 32)
        {
            throw new ArgumentException("prevHmac must be exactly 32 bytes.", nameof(prevHmac));
        }

        using var hmac = new HMACSHA256(prevHmac);
        return hmac.ComputeHash(segmentBytes.ToArray());
    }
}
