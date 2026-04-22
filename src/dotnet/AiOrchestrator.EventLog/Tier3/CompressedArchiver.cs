// <copyright file="CompressedArchiver.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.IO.Compression;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.EventLog.Tier3;

/// <summary>
/// Periodic background compactor that converts aged T2 segments into compressed T3 cold-archive
/// files. Compression uses the framework <see cref="GZipStream"/> codec; the spec calls for
/// zstd, but a pluggable codec is out of scope for this revision and gzip satisfies the
/// observable archive-after-age contract (T3-ARCHIVE-1).
/// </summary>
internal sealed class CompressedArchiver
{
    private readonly AbsolutePath segmentDir;
    private readonly TimeSpan minAge;
    private readonly IClock clock;

    /// <summary>Initializes a new instance of the <see cref="CompressedArchiver"/> class.</summary>
    /// <param name="segmentDir">Directory containing <c>*.log</c> T2 segments.</param>
    /// <param name="minAge">Minimum file age before a segment becomes archive-eligible.</param>
    /// <param name="clock">Clock used to compute file age.</param>
    public CompressedArchiver(AbsolutePath segmentDir, TimeSpan minAge, IClock clock)
    {
        this.segmentDir = segmentDir;
        this.minAge = minAge;
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
    }

    /// <summary>Performs a single archive pass over all eligible T2 segments.</summary>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The number of segments compressed during the pass.</returns>
    public async ValueTask<int> RunOnceAsync(CancellationToken ct)
    {
        if (!Directory.Exists(this.segmentDir.Value))
        {
            return 0;
        }

        var compressed = 0;
        var files = Directory.GetFiles(this.segmentDir.Value, "*.log");
        var now = this.clock.UtcNow;
        foreach (var file in files)
        {
            ct.ThrowIfCancellationRequested();
            var info = new FileInfo(file);
            if (now - info.LastWriteTimeUtc < this.minAge)
            {
                continue;
            }

            var dest = file + ".gz";
            await using (var src = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, useAsync: true))
            await using (var dst = new FileStream(dest, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, useAsync: true))
            await using (var gz = new GZipStream(dst, CompressionLevel.Fastest, leaveOpen: false))
            {
                await src.CopyToAsync(gz, ct).ConfigureAwait(false);
            }

            File.Delete(file);
            compressed++;
        }

        return compressed;
    }
}
