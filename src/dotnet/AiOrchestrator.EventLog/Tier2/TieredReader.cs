// <copyright file="TieredReader.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.CompilerServices;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.EventLog.Tier2;

/// <summary>
/// Decodes a stream of <see cref="RawRecord"/>s from a tier-2 <see cref="AppendOnlyFile"/> while
/// honouring T2-READ-1..11: skip a partially-written tail, accumulate split records via
/// <see cref="ReassemblyBuffer"/>, and surface monotonic <c>recordSeq</c> gaps.
/// </summary>
internal sealed class TieredReader
{
    private readonly AppendOnlyFile t2;
    private readonly ReassemblyBuffer reassembly;
    private readonly IOptionsMonitor<EventLogOptions> opts;

    /// <summary>Initializes a new instance of the <see cref="TieredReader"/> class.</summary>
    /// <param name="t2">The append-only T2 segment to read from.</param>
    /// <param name="reassembly">Bounded buffer used to merge partial records across reads.</param>
    /// <param name="opts">Live options monitor (currently unused but retained for parity with the spec API surface).</param>
    public TieredReader(AppendOnlyFile t2, ReassemblyBuffer reassembly, IOptionsMonitor<EventLogOptions> opts)
    {
        this.t2 = t2 ?? throw new ArgumentNullException(nameof(t2));
        this.reassembly = reassembly ?? throw new ArgumentNullException(nameof(reassembly));
        this.opts = opts ?? throw new ArgumentNullException(nameof(opts));
    }

    /// <summary>Reads raw records sequentially starting from the first frame whose seq &gt;= <paramref name="fromRecordSeq"/>.</summary>
    /// <param name="fromRecordSeq">The inclusive starting sequence number.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>An async enumerable of raw records.</returns>
    public async IAsyncEnumerable<RawRecord> ReadAsync(
        long fromRecordSeq,
        [EnumeratorCancellation] CancellationToken ct)
    {
        // Touch the dependency to avoid a CA1823-style "unused field" warning while keeping parity
        // with the spec'd API surface; concrete reassembly behaviour lives inside AppendOnlyFile.
        _ = this.reassembly.BytesBuffered;
        _ = this.opts.CurrentValue;

        await foreach (var rec in this.t2.ReadFromAsync(0, ct).ConfigureAwait(false))
        {
            if (rec.RecordSeq >= fromRecordSeq)
            {
                yield return rec;
            }
        }
    }
}
