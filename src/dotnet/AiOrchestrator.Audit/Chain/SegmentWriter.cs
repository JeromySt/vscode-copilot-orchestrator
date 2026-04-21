// <copyright file="SegmentWriter.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Audit.Crypto;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Audit.Chain;

/// <summary>
/// Persists a sealed segment atomically (INV-11): write to <c>{id}.aioa.tmp</c>, fsync, rename.
/// Computes the segment HMAC chain (INV-1) and Ed25519 signature (INV-2). The supplied
/// <see cref="Ed25519Signer"/> is the only call site permitted in the audit subsystem.
/// </summary>
internal sealed class SegmentWriter
{
    private readonly Ed25519Signer signer;
    private readonly HmacChain chain;

    public SegmentWriter(Ed25519Signer signer, HmacChain chain)
    {
        this.signer = signer;
        this.chain = chain;
    }

    /// <summary>Seals and writes a segment to disk.</summary>
    /// <param name="segmentRoot">Directory containing segment files.</param>
    /// <param name="header">Header (excluding fingerprint, which is filled by this method).</param>
    /// <param name="records">Records to embed.</param>
    /// <param name="privateKey">32-byte Ed25519 private seed used to sign the segment.</param>
    /// <param name="publicKey">32-byte Ed25519 public key embedded in the file.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The fully sealed in-memory segment.</returns>
    public async Task<Segment> WriteAsync(
        AbsolutePath segmentRoot,
        SegmentHeader header,
        ImmutableArray<AuditRecord> records,
        ReadOnlyMemory<byte> privateKey,
        ReadOnlyMemory<byte> publicKey,
        CancellationToken ct)
    {
        var fingerprint = SHA256.HashData(publicKey.Span);
        var sealedHeader = header with { SignerPubKeyFingerprint = fingerprint };

        var body = SegmentCodec.SerializeBody(sealedHeader, records);
        var hmac = this.chain.Compute(sealedHeader.PrevSegmentHmac, body);
        var toSign = SHA256.HashData(Combine(body, hmac));
        var signature = this.signer.Sign(toSign, privateKey.Span);

        var trailer = SegmentCodec.SerializeTrailer(hmac, signature, publicKey.ToArray());

        var fileName = $"{sealedHeader.SegmentSeq:D10}-{sealedHeader.SegmentId:N}.aioa";
        var finalPath = Path.Combine(segmentRoot.Value, fileName);
        var tmpPath = finalPath + ".tmp";

        // INV-11 — write tmp, flush, rename atomically.
        await using (var fs = new FileStream(tmpPath, FileMode.Create, FileAccess.Write, FileShare.None, 4096, useAsync: true))
        {
            await fs.WriteAsync(body, ct).ConfigureAwait(false);
            await fs.WriteAsync(trailer, ct).ConfigureAwait(false);
            await fs.FlushAsync(ct).ConfigureAwait(false);
            fs.Flush(flushToDisk: true);
        }

        File.Move(tmpPath, finalPath, overwrite: false);

        return new Segment
        {
            Header = sealedHeader,
            Records = records,
            Hmac = hmac,
            Ed25519Signature = signature,
            EmbeddedPublicKey = publicKey.ToArray(),
        };
    }

    private static byte[] Combine(byte[] a, byte[] b)
    {
        var combined = new byte[a.Length + b.Length];
        Buffer.BlockCopy(a, 0, combined, 0, a.Length);
        Buffer.BlockCopy(b, 0, combined, a.Length, b.Length);
        return combined;
    }
}
