// <copyright file="AuditLog.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Audit.Chain;
using AiOrchestrator.Audit.Crypto;
using AiOrchestrator.Audit.Trust;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Audit;

/// <summary>
/// Tamper-evident audit log per spec §3.5. Buffers records into a current segment, then
/// rolls over (and signs) on size or time threshold. Append failures are atomic
/// (write-tmp + fsync + rename, INV-11).
/// </summary>
public sealed class AuditLog : IAuditLog, IAsyncDisposable
{
    private readonly AbsolutePath segmentRoot;
    private readonly IFileSystem fs;
    private readonly IClock clock;
    private readonly IKeyMaterialProvider keys;
    private readonly IOptionsMonitor<AuditOptions> opts;
    private readonly EcdsaSigner signer;
    private readonly HmacChain chain;
    private readonly SegmentWriter writer;
    private readonly SegmentReader reader;
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly ImmutableArray<KeyTransitionRef> activeTransitions;

    private List<AuditRecord> currentRecords = new();
    private DateTimeOffset currentSegmentOpenedAt;
    private long currentBytesEstimate;
    private long currentSegmentSeq;
    private byte[] prevSegmentHmac = new byte[32];
    private Guid? prevSegmentId;
    private int disposed;

    /// <summary>Initializes a new <see cref="AuditLog"/>.</summary>
    /// <param name="auditRoot">Directory holding segment files (created if missing).</param>
    /// <param name="fs">File system abstraction (retained for canonicalization parity).</param>
    /// <param name="clock">Clock used for record timestamps and rollover.</param>
    /// <param name="keys">Active and historical key material.</param>
    /// <param name="opts">Live options monitor.</param>
    public AuditLog(
        AbsolutePath auditRoot,
        IFileSystem fs,
        IClock clock,
        IKeyMaterialProvider keys,
        IOptionsMonitor<AuditOptions> opts)
    {
        this.segmentRoot = auditRoot;
        this.fs = fs ?? throw new ArgumentNullException(nameof(fs));
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.keys = keys ?? throw new ArgumentNullException(nameof(keys));
        this.opts = opts ?? throw new ArgumentNullException(nameof(opts));
        this.signer = new EcdsaSigner();
        this.chain = new HmacChain();
        this.writer = new SegmentWriter(this.signer, this.chain, fs);
        this.reader = new SegmentReader(fs);
        this.activeTransitions = ImmutableArray<KeyTransitionRef>.Empty;

        if (!fs.DirectoryExistsAsync(auditRoot, CancellationToken.None).GetAwaiter().GetResult())
        {
            fs.CreateDirectoryAsync(auditRoot, CancellationToken.None).GetAwaiter().GetResult();
        }

        // INV-11 — clean up any leftover .tmp from a crash mid-write before resuming.
        this.reader.CleanupTempFilesAsync(auditRoot, CancellationToken.None).GetAwaiter().GetResult();

        // Recover state from disk: highest seq + last hmac become our continuation point.
        var existing = this.reader.ReadAllAsync(auditRoot, CancellationToken.None).GetAwaiter().GetResult();
        if (existing.Count > 0)
        {
            var last = existing[^1];
            this.currentSegmentSeq = last.Header.SegmentSeq;
            this.prevSegmentHmac = last.Hmac;
            this.prevSegmentId = last.Header.SegmentId;
        }

        this.currentSegmentOpenedAt = this.clock.UtcNow;
    }

    /// <inheritdoc />
    public async ValueTask AppendAsync(AuditRecord record, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(record);
        ObjectDisposedException.ThrowIf(Volatile.Read(ref this.disposed) != 0, this);

        await this.gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            // Check rollover BEFORE adding the new record so that a record arriving
            // after the rollover threshold lands in a FRESH segment, not the prior one.
            if (this.currentRecords.Count > 0 && this.ShouldRollover())
            {
                await this.SealCurrentSegmentAsync(ct).ConfigureAwait(false);
            }

            this.currentRecords.Add(record);
            this.currentBytesEstimate += EstimateBytes(record);

            // Re-check after adding, in case THIS record pushes us over the size limit.
            if (this.ShouldRollover())
            {
                await this.SealCurrentSegmentAsync(ct).ConfigureAwait(false);
            }
        }
        finally
        {
            _ = this.gate.Release();
        }
    }

    /// <inheritdoc />
    public async IAsyncEnumerable<AuditRecord> ReadAsync([EnumeratorCancellation] CancellationToken ct)
    {
        var sealed_ = await this.reader.ReadAllAsync(this.segmentRoot, ct).ConfigureAwait(false);
        foreach (var seg in sealed_)
        {
            foreach (var rec in seg.Records)
            {
                yield return rec;
            }
        }

        // Records still in the current open segment are not yet persisted; expose them too.
        await this.gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            foreach (var rec in this.currentRecords)
            {
                yield return rec;
            }
        }
        finally
        {
            _ = this.gate.Release();
        }
    }

    /// <inheritdoc />
    public async ValueTask<ChainVerification> VerifyAsync(VerifyMode mode, CancellationToken ct)
    {
        var segs = await this.reader.ReadAllAsync(this.segmentRoot, ct).ConfigureAwait(false);

        // Verifier needs an anchor + manifests to do its job; if not configured externally,
        // synthesize an anchor from the first segment so we at least exercise INV-1/2/3/12.
        InstallAnchor anchor;
        if (segs.Count > 0)
        {
            anchor = new InstallAnchor
            {
                InitialAuditPubKey = segs[0].EmbeddedPublicKey,
                At = segs[0].Header.CreatedAt,
                InstallId = segs[0].Header.SegmentId.ToString("N"),
                InitialAuditKeyId = segs[0].Header.SignerKeyId,
            };
        }
        else
        {
            anchor = new InstallAnchor
            {
                InitialAuditPubKey = this.keys.GetActivePublicKey().ToArray(),
                At = this.clock.UtcNow,
                InstallId = "empty",
                InitialAuditKeyId = this.keys.ActiveKeyId,
            };
        }

        var verifier = new ChainVerifier(anchor, Array.Empty<ReleaseManifest>(), Array.Empty<KeyTransition>(), this.clock);
        return verifier.Verify(segs, mode);
    }

    /// <summary>Forces the in-memory records to be flushed and sealed as a segment.</summary>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A task that completes when the segment is durable.</returns>
    public async Task FlushAsync(CancellationToken ct)
    {
        await this.gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (this.currentRecords.Count > 0)
            {
                await this.SealCurrentSegmentAsync(ct).ConfigureAwait(false);
            }
        }
        finally
        {
            _ = this.gate.Release();
        }
    }

    /// <inheritdoc />
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref this.disposed, 1) != 0)
        {
            return;
        }

        try
        {
            await this.FlushAsync(CancellationToken.None).ConfigureAwait(false);
        }
        catch
        {
            // best effort
        }

        this.gate.Dispose();
    }

    private static long EstimateBytes(AuditRecord r) =>
        (r.EventType?.Length ?? 0) + (r.ContentJson?.Length ?? 0) + 256;

    private bool ShouldRollover()
    {
        var current = this.opts.CurrentValue;
        if (this.currentBytesEstimate >= current.SegmentMaxBytes)
        {
            return true;
        }

        if (this.clock.UtcNow - this.currentSegmentOpenedAt >= current.SegmentRollover)
        {
            return true;
        }

        return false;
    }

    private async Task SealCurrentSegmentAsync(CancellationToken ct)
    {
        if (this.currentRecords.Count == 0)
        {
            return;
        }

        this.currentSegmentSeq += 1;
        var newId = Guid.NewGuid();
        var pub = this.keys.GetActivePublicKey().ToArray();
        var fingerprint = SHA256.HashData(pub);
        var header = new SegmentHeader
        {
            SegmentId = newId,
            PrevSegmentId = this.prevSegmentId,
            PrevSegmentHmac = this.prevSegmentHmac,
            SignerPubKeyFingerprint = fingerprint,
            SignerKeyId = this.keys.ActiveKeyId,
            CreatedAt = this.clock.UtcNow,
            SegmentSeq = this.currentSegmentSeq,
            EffectiveTransitions = this.activeTransitions,
        };

        var sealedSegment = await this.writer.WriteAsync(
            this.segmentRoot,
            header,
            this.currentRecords.ToImmutableArray(),
            this.keys.GetActivePrivateKey(),
            this.keys.GetActivePublicKey(),
            ct).ConfigureAwait(false);

        this.prevSegmentHmac = sealedSegment.Hmac;
        this.prevSegmentId = sealedSegment.Header.SegmentId;
        this.currentRecords = new();
        this.currentBytesEstimate = 0;
        this.currentSegmentOpenedAt = this.clock.UtcNow;
    }
}
