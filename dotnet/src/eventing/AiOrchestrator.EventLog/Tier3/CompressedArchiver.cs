// <copyright file="CompressedArchiver.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.IO.Compression;
using AiOrchestrator.Abstractions.Io;
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
    private readonly IFileSystem fs;

    /// <summary>Initializes a new instance of the <see cref="CompressedArchiver"/> class.</summary>
    /// <param name="segmentDir">Directory containing <c>*.log</c> T2 segments.</param>
    /// <param name="minAge">Minimum file age before a segment becomes archive-eligible.</param>
    /// <param name="clock">Clock used to compute file age.</param>
    /// <param name="fs">File system abstraction.</param>
    public CompressedArchiver(AbsolutePath segmentDir, TimeSpan minAge, IClock clock, IFileSystem fs)
    {
        this.segmentDir = segmentDir;
        this.minAge = minAge;
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.fs = fs ?? throw new ArgumentNullException(nameof(fs));
    }

    /// <summary>Performs a single archive pass over all eligible T2 segments.</summary>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The number of segments compressed during the pass.</returns>
    public async ValueTask<int> RunOnceAsync(CancellationToken ct)
    {
        if (!await this.fs.DirectoryExistsAsync(this.segmentDir, ct).ConfigureAwait(false))
        {
            return 0;
        }

        var compressed = 0;
        var files = new List<AbsolutePath>();
        await foreach (var f in this.fs.EnumerateFilesAsync(this.segmentDir, "*.log", ct).ConfigureAwait(false))
        {
            files.Add(f);
        }

        var now = this.clock.UtcNow;
        foreach (var file in files)
        {
            ct.ThrowIfCancellationRequested();
            var info = new FileInfo(file.Value);
            if (now - info.LastWriteTimeUtc < this.minAge)
            {
                continue;
            }

            var dest = file.Value + ".gz";
            await using (var src = new FileStream(file.Value, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, useAsync: true))
            await using (var dst = new FileStream(dest, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, useAsync: true))
            await using (var gz = new GZipStream(dst, CompressionLevel.Fastest, leaveOpen: false))
            {
                await src.CopyToAsync(gz, ct).ConfigureAwait(false);
            }

            await this.fs.DeleteAsync(file, ct).ConfigureAwait(false);
            compressed++;
        }

        return compressed;
    }
}
