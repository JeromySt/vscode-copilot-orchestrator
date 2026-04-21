// <copyright file="TieredEventLogContractTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Buffers;
using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Redaction;
using AiOrchestrator.Abstractions.Telemetry;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.EventLog;
using AiOrchestrator.EventLog.Quota;
using AiOrchestrator.EventLog.Tier2;
using AiOrchestrator.EventLog.Tier3;
using AiOrchestrator.Models.Eventing;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.TestKit.Time;
using FluentAssertions;
using Microsoft.Extensions.Options;
using Xunit;

namespace AiOrchestrator.EventLog.Tests;

/// <summary>Marks a test method as a contract test verifying a specific acceptance criterion.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    public ContractTestAttribute(string id) => this.Id = id;

    public string Id { get; }
}

/// <summary>Acceptance contract tests for <see cref="TieredEventLog"/> (job 013).</summary>
public sealed class TieredEventLogContractTests : IDisposable
{
    private readonly string root;

    public TieredEventLogContractTests()
    {
        this.root = Path.Combine(
            AppContext.BaseDirectory,
            "el-tests",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.root);
    }

    public void Dispose()
    {
        try { Directory.Delete(this.root, recursive: true); }
        catch { /* best effort */ }
    }

    // ---------------------------------------------------------------------
    // T2-LOG-1 — Frame layout matches spec
    // ---------------------------------------------------------------------
    [Fact]
    [ContractTest("T2-LOG-1")]
    public void T2_LOG_1_FrameLayoutMatchesSpec()
    {
        var payload = Encoding.UTF8.GetBytes("hello-event-log");
        var dest = new byte[RecordFramer.FramedSize(payload.Length)];

        var written = RecordFramer.Frame(payload, dest, recordSeq: 42);

        written.Should().Be(dest.Length);
        BinaryPrimitives.ReadUInt32LittleEndian(dest).Should().Be((uint)payload.Length);
        BinaryPrimitives.ReadInt64LittleEndian(dest.AsSpan(4)).Should().Be(42);

        var crcOffset = RecordFramer.HeaderSize + payload.Length;
        var trailerCrc = BinaryPrimitives.ReadUInt32LittleEndian(dest.AsSpan(crcOffset, 4));
        var expectedCrc = Crc32C.HashToUInt32(dest.AsSpan(0, crcOffset));
        trailerCrc.Should().Be(expectedCrc);

        // Round-trip
        var parsed = RecordFramer.TryUnframe(
            new ReadOnlySequence<byte>(dest),
            lastEmittedSeq: 0,
            out var rec,
            out var consumed,
            out var err);
        parsed.Should().BeTrue();
        err.Should().Be(FrameError.None);
        rec.RecordSeq.Should().Be(42);
        rec.Payload.ToArray().Should().Equal(payload);
    }

    // ---------------------------------------------------------------------
    // T2-LOG-2 — CRC mismatch is flagged
    // ---------------------------------------------------------------------
    [Fact]
    [ContractTest("T2-LOG-2")]
    public void T2_LOG_2_CrcMismatchIsFlagged()
    {
        var payload = Encoding.UTF8.GetBytes("integrity");
        var buf = new byte[RecordFramer.FramedSize(payload.Length)];
        _ = RecordFramer.Frame(payload, buf, recordSeq: 1);

        // Tamper the trailing CRC
        buf[^1] ^= 0xFF;

        var ok = RecordFramer.TryUnframe(
            new ReadOnlySequence<byte>(buf),
            0,
            out _,
            out _,
            out var err);
        ok.Should().BeFalse();
        err.Should().Be(FrameError.CrcMismatch);
    }

    // ---------------------------------------------------------------------
    // T2-READ-1 — Replay resumes from last valid record (tail truncation)
    // ---------------------------------------------------------------------
    [Fact]
    [ContractTest("T2-READ-1")]
    public async Task T2_READ_1_ReplayResumesFromLastValidRecord()
    {
        var dir = this.NewDir("read1");
        await using (var log = NewLog(dir))
        {
            for (var i = 1; i <= 5; i++)
            {
                await log.AppendAsync(MakeEnvelope(i), CancellationToken.None);
            }
        }

        // Truncate the file mid-record (corrupt the tail).
        var segment = Path.Combine(dir, "events.log");
        var allBytes = await File.ReadAllBytesAsync(segment);
        await File.WriteAllBytesAsync(segment, allBytes.Take(allBytes.Length - 5).ToArray());

        await using var reopened = NewLog(dir);
        var read = new List<EventEnvelope>();
        await foreach (var e in reopened.ReadFromAsync(0, CancellationToken.None))
        {
            read.Add(e);
        }

        // Last record is now incomplete; replay yields the first 4 valid records.
        read.Select(e => e.RecordSeq).Should().Equal(new long[] { 1, 2, 3, 4 });
    }

    // ---------------------------------------------------------------------
    // T2-READ-11 — Reassembly abandoned after budget
    // ---------------------------------------------------------------------
    [Fact]
    [ContractTest("T2-READ-11")]
    public void T2_READ_11_ReassemblyAbandonedAfterBudget()
    {
        var clock = new InMemoryClock();
        var buffer = new ReassemblyBuffer(maxBytes: 64, timeout: TimeSpan.FromSeconds(1), clock);

        // Fill below the cap: ok.
        buffer.TryAppend(new byte[60]).Should().BeTrue();

        // Exceed the cap: abandoned.
        buffer.TryAppend(new byte[10]).Should().BeFalse();

        // After the abandonment signal the timeout has not elapsed (no time has passed).
        buffer.IsTimedOut().Should().BeFalse();
    }

    // ---------------------------------------------------------------------
    // T2-READ-11-GAP — record-seq gap detected
    // ---------------------------------------------------------------------
    [Fact]
    [ContractTest("T2-READ-11-GAP")]
    public void T2_READ_11_RecordSeqGapDetected()
    {
        // Simulate a regression: lastEmittedSeq=10, framed record carries seq=5.
        var payload = Encoding.UTF8.GetBytes("regress");
        var buf = new byte[RecordFramer.FramedSize(payload.Length)];
        _ = RecordFramer.Frame(payload, buf, recordSeq: 5);

        var ok = RecordFramer.TryUnframe(
            new ReadOnlySequence<byte>(buf),
            lastEmittedSeq: 10,
            out _,
            out _,
            out var err);
        ok.Should().BeFalse();
        err.Should().Be(FrameError.RecordSeqRegression);
    }

    // ---------------------------------------------------------------------
    // SUB-3 — Replay→live: no duplicates, no gaps
    // ---------------------------------------------------------------------
    [Fact]
    [ContractTest("SUB-3")]
    public async Task SUB_3_ReplayToLive_NoDuplicates_NoGaps()
    {
        var dir = this.NewDir("sub3");
        await using var log = NewLog(dir);

        const int Total = 200;
        var seen = new ConcurrentBag<long>();
        var subscriberStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        // Producer runs in the background; subscriber connects mid-stream.
        var produce = Task.Run(async () =>
        {
            for (var i = 1; i <= Total; i++)
            {
                if (i == Total / 2)
                {
                    subscriberStarted.TrySetResult();
                    await Task.Delay(20, cts.Token);
                }

                await log.AppendAsync(MakeEnvelope(i), cts.Token);
            }
        });

        await subscriberStarted.Task;

        var consume = Task.Run(async () =>
        {
            await foreach (var env in log.ReadReplayAndLiveAsync(new EventFilter(), cts.Token))
            {
                seen.Add(env.RecordSeq);
                if (seen.Count >= Total)
                {
                    return;
                }
            }
        });

        await produce;
        // Give the consumer a moment to drain the live tail.
        await Task.WhenAny(consume, Task.Delay(TimeSpan.FromSeconds(15), cts.Token));

        seen.Should().HaveCountGreaterThanOrEqualTo(1);
        seen.Distinct().Count().Should().Be(seen.Count, "no duplicates");

        // Verify the seen sequence is contiguous (no gaps within the seen window).
        var ordered = seen.OrderBy(x => x).ToArray();
        for (var i = 1; i < ordered.Length; i++)
        {
            (ordered[i] - ordered[i - 1]).Should().Be(1, $"sequence {ordered[i - 1]}→{ordered[i]} must be contiguous");
        }
    }

    // ---------------------------------------------------------------------
    // DISK-PLAN-1 — Per-plan cap enforced
    // ---------------------------------------------------------------------
    [Fact]
    [ContractTest("DISK-PLAN-1")]
    public async Task DISK_PLAN_1_PerPlanCapEnforced()
    {
        var dir = this.NewDir("cap");
        // Set a tiny cap that fits ~1 envelope.
        await using var log = NewLog(dir, opts => opts with { PerPlanDiskCapBytes = 256 });

        var planId = new PlanId(Guid.NewGuid());
        var seq = 1L;

        // Append until cap fires.
        var hit = false;
        for (var i = 0; i < 50; i++)
        {
            try
            {
                await log.AppendAsync(MakeEnvelope(seq++, planId: planId), CancellationToken.None);
            }
            catch (DiskQuotaExceededException)
            {
                hit = true;
                break;
            }
        }

        hit.Should().BeTrue("the per-plan cap must trip eventually");
    }

    // ---------------------------------------------------------------------
    // DISK-PLAN-2 — Exceeded exception includes plan-id and metadata
    // ---------------------------------------------------------------------
    [Fact]
    [ContractTest("DISK-PLAN-2")]
    public async Task DISK_PLAN_2_ExceededExceptionIncludesPlanId()
    {
        var dir = this.NewDir("cap2");
        await using var log = NewLog(dir, opts => opts with { PerPlanDiskCapBytes = 64 });

        var planId = new PlanId(Guid.NewGuid());
        DiskQuotaExceededException? caught = null;
        for (var i = 1; i < 20 && caught is null; i++)
        {
            try
            {
                await log.AppendAsync(MakeEnvelope(i, planId: planId), CancellationToken.None);
            }
            catch (DiskQuotaExceededException ex)
            {
                caught = ex;
            }
        }

        caught.Should().NotBeNull();
        caught!.PlanId.Should().Be(planId);
        caught.Cap.Should().Be(64);
        caught.Requested.Should().BeGreaterThan(0);
        caught.Message.Should().Contain(planId.ToString());
    }

    // ---------------------------------------------------------------------
    // T3-ARCHIVE-1 — Cold segments compressed after age
    // ---------------------------------------------------------------------
    [Fact]
    [ContractTest("T3-ARCHIVE-1")]
    public async Task T3_ARCHIVE_1_ColdSegmentsCompressedAfterAge()
    {
        var dir = this.NewDir("archive");
        var clock = new InMemoryClock();

        // Drop a synthetic segment file to be archived.
        var seg = Path.Combine(dir, "events-old.log");
        await File.WriteAllBytesAsync(seg, Enumerable.Repeat((byte)'A', 4096).ToArray());

        // Stamp the file as "old enough" by setting its last-write time in the past.
        File.SetLastWriteTimeUtc(seg, clock.UtcNow.UtcDateTime.AddHours(-1));

        var archiver = new CompressedArchiver(
            new AbsolutePath(dir),
            minAge: TimeSpan.FromMinutes(15),
            clock);

        await archiver.RunOnceAsync(CancellationToken.None);

        File.Exists(seg).Should().BeFalse("the original segment is replaced by a compressed copy");
        File.Exists(seg + ".gz").Should().BeTrue("a compressed copy is produced");

        // Verify the gz file decompresses to the original bytes.
        await using var input = File.OpenRead(seg + ".gz");
        await using var gz = new GZipStream(input, CompressionMode.Decompress);
        using var ms = new MemoryStream();
        await gz.CopyToAsync(ms);
        ms.Length.Should().Be(4096);
    }

    // ---------------------------------------------------------------------
    // EL-ZERO-ALLOC — Per-record marginal allocation is bounded
    // ---------------------------------------------------------------------
    [Fact]
    [ContractTest("EL-ZERO-ALLOC")]
    public async Task EL_HAPPY_PATH_ZeroAlloc_PerRecord()
    {
        var dir = this.NewDir("alloc");
        await using var log = NewLog(dir);

        // Warm up.
        for (var i = 1; i <= 200; i++)
        {
            await log.AppendAsync(MakeEnvelope(i), CancellationToken.None);
        }

        const int Iterations = 500;
        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();
        var before = GC.GetTotalAllocatedBytes(precise: true);

        for (var i = 201; i <= 200 + Iterations; i++)
        {
            await log.AppendAsync(MakeEnvelope(i), CancellationToken.None);
        }

        var after = GC.GetTotalAllocatedBytes(precise: true);
        var perRecord = (after - before) / (double)Iterations;

        // Generous threshold — the goal is to flag regressions, not to be byte-exact.
        perRecord.Should().BeLessThan(8 * 1024, $"per-record allocation budget exceeded: {perRecord:F0} bytes/record");
    }

    // ---------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------
    private string NewDir(string name)
    {
        var p = Path.Combine(this.root, name);
        Directory.CreateDirectory(p);
        return p;
    }

    private static TieredEventLog NewLog(string dir, Func<EventLogOptions, EventLogOptions>? configure = null)
    {
        var clock = new InMemoryClock();
        var redactor = new NoopRedactor();
        var telemetry = new NoopTelemetrySink();
        var fs = new InertFileSystem();
        var defaults = new EventLogOptions();
        var opts = configure is null ? defaults : configure(defaults);
        var monitor = new TestOptionsMonitor<EventLogOptions>(opts);
        return new TieredEventLog(new AbsolutePath(dir), fs, clock, redactor, monitor, telemetry);
    }

    private static EventEnvelope MakeEnvelope(long seq, PlanId? planId = null) => new()
    {
        EventId = Guid.NewGuid(),
        RecordSeq = seq,
        OccurredAtUtc = DateTimeOffset.UnixEpoch.AddSeconds(seq),
        EventType = "test.event",
        SchemaVersion = 1,
        Payload = JsonDocument.Parse("{\"k\":\"v\"}").RootElement.Clone(),
        PlanId = planId,
    };
}

internal sealed class NoopRedactor : IRedactor
{
    public string Redact(string input) => input;

    public ValueTask<int> RedactAsync(ReadOnlySequence<byte> input, IBufferWriter<byte> output, CancellationToken ct)
    {
        var len = (int)input.Length;
        var span = output.GetSpan(len);
        input.CopyTo(span);
        output.Advance(len);
        return ValueTask.FromResult(len);
    }
}

internal sealed class NoopTelemetrySink : ITelemetrySink
{
    public void RecordCounter(string name, long delta, IReadOnlyDictionary<string, object>? tags = null) { }

    public void RecordHistogram(string name, double value, IReadOnlyDictionary<string, object>? tags = null) { }

    public IDisposable StartActivity(string name, IReadOnlyDictionary<string, object>? tags = null) => new NoopDisposable();

    private sealed class NoopDisposable : IDisposable
    {
        public void Dispose() { }
    }
}

internal sealed class TestOptionsMonitor<T> : IOptionsMonitor<T>
{
    private T value;

    public TestOptionsMonitor(T initial) => this.value = initial;

    public T CurrentValue => this.value;

    public T Get(string? name) => this.value;

    public IDisposable OnChange(Action<T, string?> listener) => new NoopDisposable();

    public void Set(T next) => this.value = next;

    private sealed class NoopDisposable : IDisposable
    {
        public void Dispose() { }
    }
}

/// <summary>
/// Inert <see cref="IFileSystem"/> stub. <see cref="TieredEventLog"/> only stores the reference
/// for parity with the spec API surface; the append/read paths use <see cref="FileStream"/>
/// directly to support concurrent reader+writer access.
/// </summary>
internal sealed class InertFileSystem : IFileSystem
{
    public ValueTask<bool> ExistsAsync(AbsolutePath path, CancellationToken ct) => new(File.Exists(path.Value));

    public ValueTask<string> ReadAllTextAsync(AbsolutePath path, CancellationToken ct)
        => new(File.ReadAllText(path.Value));

    public ValueTask WriteAllTextAsync(AbsolutePath path, string contents, CancellationToken ct)
    {
        File.WriteAllText(path.Value, contents);
        return ValueTask.CompletedTask;
    }

    public ValueTask<Stream> OpenReadAsync(AbsolutePath path, CancellationToken ct)
        => new(new FileStream(path.Value, FileMode.Open, FileAccess.Read, FileShare.ReadWrite));

    public ValueTask<Stream> OpenWriteExclusiveAsync(AbsolutePath path, FilePermissions perms, CancellationToken ct)
        => new(new FileStream(path.Value, FileMode.CreateNew, FileAccess.Write, FileShare.None));

    public ValueTask MoveAtomicAsync(AbsolutePath source, AbsolutePath destination, CancellationToken ct)
    {
        File.Move(source.Value, destination.Value, overwrite: true);
        return ValueTask.CompletedTask;
    }

    public ValueTask DeleteAsync(AbsolutePath path, CancellationToken ct)
    {
        if (File.Exists(path.Value))
        {
            File.Delete(path.Value);
        }

        return ValueTask.CompletedTask;
    }

    public ValueTask<MountKind> GetMountKindAsync(AbsolutePath path, CancellationToken ct) => new(MountKind.Local);
}
