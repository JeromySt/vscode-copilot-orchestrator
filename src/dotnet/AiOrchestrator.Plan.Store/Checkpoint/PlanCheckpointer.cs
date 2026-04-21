// <copyright file="PlanCheckpointer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Plan.Models;

namespace AiOrchestrator.Plan.Store;

/// <summary>
/// Reads and writes plan checkpoints. Writes are atomic: <c>*.tmp</c> file is fully written
/// and fsynced before an atomic rename to the final path (INV-6).
/// </summary>
internal sealed class PlanCheckpointer
{
    private readonly AbsolutePath path;
    #pragma warning disable CA1823, IDE0052
    private readonly IFileSystem fs;
    #pragma warning restore CA1823, IDE0052

    /// <summary>Initializes a new <see cref="PlanCheckpointer"/>.</summary>
    /// <param name="path">Destination path of the final checkpoint file.</param>
    /// <param name="fs">File-system abstraction (retained for parity).</param>
    public PlanCheckpointer(AbsolutePath path, IFileSystem fs)
    {
        this.path = path;
        this.fs = fs ?? throw new ArgumentNullException(nameof(fs));
    }

    /// <summary>Atomically writes a plan checkpoint capturing state up to <paramref name="upToSeq"/>.</summary>
    /// <param name="plan">The plan snapshot to persist.</param>
    /// <param name="upToSeq">The highest journal sequence already applied to <paramref name="plan"/>.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A completed task.</returns>
    public async ValueTask WriteAsync(AiOrchestrator.Plan.Models.Plan plan, long upToSeq, CancellationToken ct)
    {
        var dir = Path.GetDirectoryName(this.path.Value);
        if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
        {
            _ = Directory.CreateDirectory(dir);
        }

        var planJson = PlanJson.Serialize(plan);
        var wrapper = "{\"upToSeq\":" + upToSeq.ToString(CultureInfo.InvariantCulture) + ",\"plan\":" + planJson + "}";

        var tmpPath = this.path.Value + ".tmp";
        await using (var fstream = new FileStream(tmpPath, FileMode.Create, FileAccess.Write, FileShare.None, 4096, useAsync: true))
        {
            var bytes = Encoding.UTF8.GetBytes(wrapper);
            await fstream.WriteAsync(bytes, ct).ConfigureAwait(false);
            await fstream.FlushAsync(ct).ConfigureAwait(false);
            try
            {
                fstream.Flush(flushToDisk: true);
            }
            catch
            {
                // best-effort fsync
            }
        }

        // Atomic move (INV-6).
        File.Move(tmpPath, this.path.Value, overwrite: true);
    }

    /// <summary>Loads the latest checkpoint from disk, or <see langword="null"/> if none exists.</summary>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A tuple of (plan, upToSeq) or <see langword="null"/>.</returns>
    public async ValueTask<(AiOrchestrator.Plan.Models.Plan Plan, long UpToSeq)?> LoadLatestAsync(CancellationToken ct)
    {
        if (!File.Exists(this.path.Value))
        {
            return null;
        }

        string text;
        await using (var fstream = new FileStream(this.path.Value, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, useAsync: true))
        using (var reader = new StreamReader(fstream, Encoding.UTF8))
        {
            text = await reader.ReadToEndAsync(ct).ConfigureAwait(false);
        }

        using var doc = JsonDocument.Parse(text);
        var root = doc.RootElement;
        var upToSeq = root.GetProperty("upToSeq").GetInt64();
        var planJson = root.GetProperty("plan").GetRawText();
        var plan = PlanJson.Deserialize(planJson) ?? throw new PlanJournalCorruptedException("Checkpoint file is empty or malformed.");
        return (plan, upToSeq);
    }
}
