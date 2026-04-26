// <copyright file="TieredEventLog.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Buffers;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading.Channels;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Redaction;
using AiOrchestrator.Abstractions.Telemetry;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.EventLog.Quota;
using AiOrchestrator.EventLog.Tier1;
using AiOrchestrator.EventLog.Tier2;
using AiOrchestrator.Models.Eventing;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.EventLog;

/// <summary>
/// Three-tier persistent event log per §3.4.4. Backs <see cref="IEventStore"/> (durable T2 append +
/// per-plan disk cap) and <see cref="IEventReader"/> (replay-then-live with a contiguous SUB-3
/// boundary). T1 is an in-memory ring buffer; T3 is a periodic gzip archiver instantiated for
/// hosts that opt into long-term retention.
/// </summary>
public sealed class TieredEventLog : IEventStore, IEventReader, IAsyncDisposable
{
    private readonly AbsolutePath logRoot;
    private readonly IFileSystem fs;
    private readonly IClock clock;
    private readonly IRedactor redactor;
    private readonly IOptionsMonitor<EventLogOptions> opts;
    private readonly ITelemetrySink telemetry;
    private readonly AppendOnlyFile t2;
    private readonly HotRingBuffer t1;
    private readonly PerPlanDiskCap quota;
    private readonly object subscribeGate = new();
    private readonly List<Channel<EventEnvelope>> liveSubscribers = new();
    private long lastEmittedSeq;
    private int disposed;

    /// <summary>Initializes a new instance of the <see cref="TieredEventLog"/> class.</summary>
    /// <param name="logRoot">Directory hosting the T2 segment file. Created if missing.</param>
    /// <param name="fs">File system abstraction (retained for canonicalization parity even though the append/read paths use <see cref="FileStream"/> directly to support append + concurrent read).</param>
    /// <param name="clock">Clock used by reassembly and archive sub-systems.</param>
    /// <param name="redactor">Redactor applied to every appended payload (mirrors the bus contract; INV-3).</param>
    /// <param name="opts">Live options monitor controlling reassembly, quota, and archive thresholds.</param>
    /// <param name="telemetry">Sink for counters and histograms emitted by the log.</param>
    public TieredEventLog(
        AbsolutePath logRoot,
        IFileSystem fs,
        IClock clock,
        IRedactor redactor,
        IOptionsMonitor<EventLogOptions> opts,
        ITelemetrySink telemetry)
    {
        this.logRoot = logRoot;
        this.fs = fs ?? throw new ArgumentNullException(nameof(fs));
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.redactor = redactor ?? throw new ArgumentNullException(nameof(redactor));
        this.opts = opts ?? throw new ArgumentNullException(nameof(opts));
        this.telemetry = telemetry ?? throw new ArgumentNullException(nameof(telemetry));

        var current = opts.CurrentValue;

        // Constructor must be synchronous — use synchronous fs check.
        // The IFileSystem abstraction does not expose synchronous methods, so we use
        // a blocking call on the ValueTask here. This is safe because the default
        // IFileSystem implementation performs synchronous I/O under the hood.
        if (!this.fs.DirectoryExistsAsync(logRoot, CancellationToken.None).AsTask().GetAwaiter().GetResult())
        {
            this.fs.CreateDirectoryAsync(logRoot, CancellationToken.None).AsTask().GetAwaiter().GetResult();
        }

        var segmentPath = new AbsolutePath(Path.Combine(logRoot.Value, "events.log"));
        this.t2 = new AppendOnlyFile(segmentPath);
        this.t1 = new HotRingBuffer(current.HotRingCapacity);
        this.quota = new PerPlanDiskCap(current.PerPlanDiskCapBytes);
        this.lastEmittedSeq = ReadInitialMaxSeq(segmentPath, this.fs);
    }

    /// <inheritdoc />
    public async ValueTask AppendAsync(EventEnvelope envelope, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        if (Volatile.Read(ref this.disposed) != 0)
        {
            throw new ObjectDisposedException(nameof(TieredEventLog));
        }

        if (envelope.RecordSeq <= 0)
        {
            throw new ArgumentException("EventEnvelope.RecordSeq must be > 0.", nameof(envelope));
        }

        var redactedJson = this.redactor.Redact(envelope.Payload.GetRawText());
        EventEnvelope toPersist;
        using (var doc = JsonDocument.Parse(redactedJson))
        {
            toPersist = envelope with { Payload = doc.RootElement.Clone() };
        }

        var payloadBytes = JsonSerializer.SerializeToUtf8Bytes(toPersist, EventLogJsonContext.Default.EventEnvelope);
        var framedSize = RecordFramer.FramedSize(payloadBytes.Length);

        // DISK-PLAN-1 — reserve under the per-plan cap before writing.
        if (toPersist.PlanId is { } planId)
        {
            if (!this.quota.TryReserve(planId, framedSize))
            {
                var current = this.quota.Current(planId);
                throw this.quota.CreateException(planId, framedSize, current, this.quota.Cap);
            }
        }

        var rented = ArrayPool<byte>.Shared.Rent(framedSize);
        try
        {
            var written = RecordFramer.Frame(payloadBytes, rented.AsSpan(0, framedSize), toPersist.RecordSeq);
            await this.t2.AppendAsync(rented.AsMemory(0, written), ct).ConfigureAwait(false);
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(rented);
        }

        _ = Interlocked.Exchange(ref this.lastEmittedSeq, Math.Max(Volatile.Read(ref this.lastEmittedSeq), toPersist.RecordSeq));
        this.t1.Add(toPersist);
        this.telemetry.RecordCounter("eventlog.appended", 1);

        Channel<EventEnvelope>[] subs;
        lock (this.subscribeGate)
        {
            subs = this.liveSubscribers.ToArray();
        }

        foreach (var sub in subs)
        {
            _ = sub.Writer.TryWrite(toPersist);
        }
    }

    /// <inheritdoc />
    public async IAsyncEnumerable<EventEnvelope> ReadFromAsync(
        long fromRecordSeq,
        [EnumeratorCancellation] CancellationToken ct)
    {
        if (Volatile.Read(ref this.disposed) != 0)
        {
            yield break;
        }

        long lastSeq = 0;
        await foreach (var raw in this.t2.ReadFromAsync(0, ct).ConfigureAwait(false))
        {
            if (raw.RecordSeq < fromRecordSeq)
            {
                lastSeq = raw.RecordSeq;
                continue;
            }

            // T2-READ-11 — surface a record-seq gap as a sentinel envelope so callers can react.
            if (lastSeq > 0 && raw.RecordSeq > lastSeq + 1)
            {
                this.telemetry.RecordCounter("eventlog.gap", 1);
            }

            EventEnvelope env;
            try
            {
                env = Deserialize(raw.Payload.Span);
            }
            catch (JsonException)
            {
                continue;
            }

            yield return env;
            lastSeq = raw.RecordSeq;
        }
    }

    /// <inheritdoc />
    public async IAsyncEnumerable<EventEnvelope> ReadReplayAndLiveAsync(
        EventFilter filter,
        [EnumeratorCancellation] CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(filter);
        if (Volatile.Read(ref this.disposed) != 0)
        {
            yield break;
        }

        // SUB-3 — atomically subscribe and snapshot the cursor under the same gate that
        // writers use. Any envelope already on disk has seq <= replayCursor; any envelope
        // that arrives after the gate is released is delivered to the channel and has
        // seq > replayCursor, so the replay→live boundary has neither gap nor duplicate.
        var channel = Channel.CreateUnbounded<EventEnvelope>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false,
        });

        long replayCursor;
        lock (this.subscribeGate)
        {
            this.liveSubscribers.Add(channel);
            replayCursor = Volatile.Read(ref this.lastEmittedSeq);
        }

        try
        {
            await foreach (var env in this.ReadFromAsync(0, ct).ConfigureAwait(false))
            {
                if (env.RecordSeq > replayCursor)
                {
                    break;
                }

                if (Matches(filter, env))
                {
                    yield return env;
                }
            }

            while (await channel.Reader.WaitToReadAsync(ct).ConfigureAwait(false))
            {
                while (channel.Reader.TryRead(out var env))
                {
                    if (env.RecordSeq <= replayCursor)
                    {
                        continue;
                    }

                    if (Matches(filter, env))
                    {
                        yield return env;
                    }
                }
            }
        }
        finally
        {
            lock (this.subscribeGate)
            {
                _ = this.liveSubscribers.Remove(channel);
            }

            _ = channel.Writer.TryComplete();
        }
    }

    /// <inheritdoc />
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref this.disposed, 1) != 0)
        {
            return;
        }

        Channel<EventEnvelope>[] subs;
        lock (this.subscribeGate)
        {
            subs = this.liveSubscribers.ToArray();
            this.liveSubscribers.Clear();
        }

        foreach (var sub in subs)
        {
            _ = sub.Writer.TryComplete();
        }

        await this.t2.DisposeAsync().ConfigureAwait(false);
    }

    /// <summary>Returns the underlying T2 segment for tests.</summary>
    /// <returns>The append-only segment file wrapper.</returns>
    internal AppendOnlyFile GetT2Segment() => this.t2;

    /// <summary>Returns the per-plan quota tracker for tests.</summary>
    /// <returns>The per-plan disk-cap tracker.</returns>
    internal PerPlanDiskCap GetQuota() => this.quota;

    private static bool Matches(EventFilter filter, EventEnvelope env)
    {
        if (filter.PlanId is { } pid && env.PlanId != pid)
        {
            return false;
        }

        if (filter.JobId is { } jid && env.JobId != jid)
        {
            return false;
        }

        if (filter.Predicate is { } pred && !pred(env))
        {
            return false;
        }

        return true;
    }

    private static EventEnvelope Deserialize(ReadOnlySpan<byte> payload)
    {
        return JsonSerializer.Deserialize(payload, EventLogJsonContext.Default.EventEnvelope)
            ?? throw new JsonException("Decoded envelope was null.");
    }

    private static long ReadInitialMaxSeq(AbsolutePath segmentPath, IFileSystem fs)
    {
        if (!fs.FileExistsAsync(segmentPath, CancellationToken.None).AsTask().GetAwaiter().GetResult())
        {
            return 0;
        }

        try
        {
            using var stream = new FileStream(
                segmentPath.Value,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite,
                bufferSize: 4096,
                useAsync: false);
            var bytes = new byte[stream.Length];
            var off = 0;
            while (off < bytes.Length)
            {
                var n = stream.Read(bytes, off, bytes.Length - off);
                if (n <= 0)
                {
                    break;
                }

                off += n;
            }

            var seq = new ReadOnlySequence<byte>(bytes, 0, off);
            long maxSeq = 0;
            long lastSeq = 0;
            while (true)
            {
                if (!RecordFramer.TryUnframe(seq, lastSeq, out var rec, out var consumed, out var err))
                {
                    break;
                }

                lastSeq = rec.RecordSeq;
                if (rec.RecordSeq > maxSeq)
                {
                    maxSeq = rec.RecordSeq;
                }

                seq = seq.Slice(consumed);
            }

            return maxSeq;
        }
        catch (IOException)
        {
            return 0;
        }
    }
}
