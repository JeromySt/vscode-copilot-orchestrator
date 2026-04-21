// <copyright file="PlanJournal.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Plan.Store;

/// <summary>
/// Append-only journal of <see cref="PlanMutation"/> entries for a single plan. One NDJSON
/// line per mutation. Append is fsynced for crash-safety (INV-6). Gap detection at read
/// time raises <see cref="PlanJournalCorruptedException"/> (INV-8).
/// </summary>
internal sealed class PlanJournal : IAsyncDisposable
{
    private readonly AbsolutePath path;
    #pragma warning disable CA1823, IDE0052
    private readonly IFileSystem fs;
    private readonly IClock clock;
    #pragma warning restore CA1823, IDE0052
    private readonly SemaphoreSlim gate = new(1, 1);
    private int disposed;

    /// <summary>Initializes a new <see cref="PlanJournal"/> backed by <paramref name="path"/>.</summary>
    /// <param name="path">The NDJSON file holding journal entries.</param>
    /// <param name="fs">File-system abstraction (retained for parity / future use).</param>
    /// <param name="clock">Clock abstraction (retained for parity / future use).</param>
    public PlanJournal(AbsolutePath path, IFileSystem fs, IClock clock)
    {
        this.path = path;
        this.fs = fs ?? throw new ArgumentNullException(nameof(fs));
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
    }

    /// <summary>Appends a new entry (metadata + content hash + payload) to the journal and fsyncs.</summary>
    /// <param name="mutation">The mutation whose payload to serialize.</param>
    /// <param name="contentHash">The canonical content hash for this mutation.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A task that completes when the data is durable.</returns>
    public async ValueTask AppendAsync(PlanMutation mutation, string contentHash, CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref this.disposed) != 0, this);

        var line = MutationJson.SerializeEntry(mutation, contentHash) + "\n";
        await this.gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var dir = Path.GetDirectoryName(this.path.Value);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            {
                _ = Directory.CreateDirectory(dir);
            }

            // Open append-exclusive, write, fsync, close.
            await using var fstream = new FileStream(
                this.path.Value,
                FileMode.Append,
                FileAccess.Write,
                FileShare.Read,
                bufferSize: 4096,
                useAsync: true);
            var bytes = System.Text.Encoding.UTF8.GetBytes(line);
            await fstream.WriteAsync(bytes, ct).ConfigureAwait(false);
            await fstream.FlushAsync(ct).ConfigureAwait(false);
            try
            {
                fstream.Flush(flushToDisk: true);
            }
            catch
            {
                // best effort fsync
            }
        }
        finally
        {
            _ = this.gate.Release();
        }
    }

    /// <summary>Reads all entries from the journal with Seq &gt;= <paramref name="fromSeq"/>.</summary>
    /// <param name="fromSeq">Inclusive minimum sequence.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>An async sequence of mutations in ascending Seq order.</returns>
    public async IAsyncEnumerable<PlanMutation> ReadFromAsync(long fromSeq, [EnumeratorCancellation] CancellationToken ct)
    {
        if (!File.Exists(this.path.Value))
        {
            yield break;
        }

        // Read entire file, verify gap-free ascending sequence, then yield starting at fromSeq.
        var all = new List<PlanMutation>();
        await using (var fstream = new FileStream(this.path.Value, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, useAsync: true))
        using (var reader = new StreamReader(fstream, System.Text.Encoding.UTF8))
        {
            string? line;
            long expected = -1;
            while ((line = await reader.ReadLineAsync(ct).ConfigureAwait(false)) != null)
            {
                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                var m = MutationJson.DeserializeEntry(line);
                if (expected < 0)
                {
                    expected = m.Seq;
                }

                if (m.Seq != expected)
                {
                    throw new PlanJournalCorruptedException(
                        $"Journal gap or reorder: expected seq {expected}, got {m.Seq}.");
                }

                all.Add(m);
                expected = m.Seq + 1;
            }
        }

        foreach (var m in all)
        {
            if (m.Seq >= fromSeq)
            {
                yield return m;
            }
        }
    }

    /// <summary>Checks whether a given idempotency key already appears in the journal.</summary>
    /// <param name="key">Idempotency key to look up.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The stored mutation with that key, or <see langword="null"/> if not found.</returns>
    public async ValueTask<PlanMutation?> FindByIdempotencyKeyAsync(IdempotencyKey key, CancellationToken ct)
    {
        await foreach (var m in this.ReadFromAsync(0, ct).ConfigureAwait(false))
        {
            if (string.Equals(m.IdemKey.Value, key.Value, StringComparison.Ordinal))
            {
                return m;
            }
        }

        return null;
    }

    /// <summary>Convenience wrapper around <see cref="FindByIdempotencyKeyAsync"/>.</summary>
    /// <param name="key">Idempotency key.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns><see langword="true"/> if the key exists in the journal.</returns>
    public async ValueTask<bool> ContainsIdempotencyKeyAsync(IdempotencyKey key, CancellationToken ct)
        => await this.FindByIdempotencyKeyAsync(key, ct).ConfigureAwait(false) != null;

    /// <inheritdoc />
    public ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref this.disposed, 1) != 0)
        {
            return ValueTask.CompletedTask;
        }

        this.gate.Dispose();
        return ValueTask.CompletedTask;
    }
}
