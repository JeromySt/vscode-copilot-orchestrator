// <copyright file="ITransparencyLog.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Audit.Trust;

/// <summary>
/// Sigstore-style transparency log facade consulted by <see cref="VerifyMode.Strict"/> verification
/// (TRUST-ROOT-6). The default in-memory implementation is for tests; production wires this to
/// an external rekor-style log.
/// </summary>
public interface ITransparencyLog
{
    /// <summary>Returns <see langword="true"/> if the segment fingerprint is present in the log.</summary>
    /// <param name="segmentBodyHash">SHA-256 of the segment body bytes.</param>
    /// <param name="signature">The Ed25519 signature recorded for the segment.</param>
    /// <returns><see langword="true"/> if the fingerprint is logged.</returns>
    bool Contains(ReadOnlySpan<byte> segmentBodyHash, ReadOnlySpan<byte> signature);
}
