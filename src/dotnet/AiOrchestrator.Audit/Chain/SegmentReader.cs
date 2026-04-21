// <copyright file="SegmentReader.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Audit.Chain;

/// <summary>Reads sealed segment files back from disk in monotonic sequence order.</summary>
internal sealed class SegmentReader
{
    /// <summary>Lists all sealed (non-tmp) segments, sorted by sequence number.</summary>
    /// <param name="segmentRoot">Directory containing segment files.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The full list of decoded segments.</returns>
    public async Task<IReadOnlyList<Segment>> ReadAllAsync(AbsolutePath segmentRoot, CancellationToken ct)
    {
        if (!Directory.Exists(segmentRoot.Value))
        {
            return System.Array.Empty<Segment>();
        }

        var files = Directory.EnumerateFiles(segmentRoot.Value, "*.aioa")
            .Where(f => !f.EndsWith(".tmp", System.StringComparison.Ordinal))
            .OrderBy(f => Path.GetFileName(f), System.StringComparer.Ordinal)
            .ToList();

        var segments = new List<Segment>(files.Count);
        foreach (var f in files)
        {
            ct.ThrowIfCancellationRequested();
            var raw = await File.ReadAllBytesAsync(f, ct).ConfigureAwait(false);
            segments.Add(SegmentCodec.Decode(raw, out _));
        }

        return segments;
    }

    /// <summary>Removes any leftover <c>.tmp</c> files from a crash mid-write (INV-11 recovery).</summary>
    /// <param name="segmentRoot">Directory containing segment files.</param>
    public void CleanupTempFiles(AbsolutePath segmentRoot)
    {
        if (!Directory.Exists(segmentRoot.Value))
        {
            return;
        }

        foreach (var f in Directory.EnumerateFiles(segmentRoot.Value, "*.aioa.tmp"))
        {
            try
            {
                File.Delete(f);
            }
            catch (IOException)
            {
                // best effort
            }
        }
    }
}
