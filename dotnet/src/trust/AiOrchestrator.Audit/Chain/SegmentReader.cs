// <copyright file="SegmentReader.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Audit.Chain;

/// <summary>Reads sealed segment files back from disk in monotonic sequence order.</summary>
internal sealed class SegmentReader
{
    private readonly IFileSystem fs;

    public SegmentReader(IFileSystem fs)
    {
        this.fs = fs ?? throw new ArgumentNullException(nameof(fs));
    }

    /// <summary>Lists all sealed (non-tmp) segments, sorted by sequence number.</summary>
    /// <param name="segmentRoot">Directory containing segment files.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The full list of decoded segments.</returns>
    public async Task<IReadOnlyList<Segment>> ReadAllAsync(AbsolutePath segmentRoot, CancellationToken ct)
    {
        if (!await this.fs.DirectoryExistsAsync(segmentRoot, ct).ConfigureAwait(false))
        {
            return Array.Empty<Segment>();
        }

        var files = new List<AbsolutePath>();
        await foreach (var f in this.fs.EnumerateFilesAsync(segmentRoot, "*.aioa", ct).ConfigureAwait(false))
        {
            if (!f.Value.EndsWith(".tmp", StringComparison.Ordinal))
            {
                files.Add(f);
            }
        }

        files.Sort((a, b) => string.Compare(
            Path.GetFileName(a.Value), Path.GetFileName(b.Value), StringComparison.Ordinal));

        var segments = new List<Segment>(files.Count);
        foreach (var f in files)
        {
            ct.ThrowIfCancellationRequested();
            var raw = await this.fs.ReadAllBytesAsync(f, ct).ConfigureAwait(false);
            segments.Add(SegmentCodec.Decode(raw, out _));
        }

        return segments;
    }

    /// <summary>Removes any leftover <c>.tmp</c> files from a crash mid-write (INV-11 recovery).</summary>
    /// <param name="segmentRoot">Directory containing segment files.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A task that completes when cleanup is finished.</returns>
    public async Task CleanupTempFilesAsync(AbsolutePath segmentRoot, CancellationToken ct)
    {
        if (!await this.fs.DirectoryExistsAsync(segmentRoot, ct).ConfigureAwait(false))
        {
            return;
        }

        await foreach (var f in this.fs.EnumerateFilesAsync(segmentRoot, "*.aioa.tmp", ct).ConfigureAwait(false))
        {
            try
            {
                await this.fs.DeleteAsync(f, ct).ConfigureAwait(false);
            }
            catch (IOException)
            {
                // best effort
            }
        }
    }
}
