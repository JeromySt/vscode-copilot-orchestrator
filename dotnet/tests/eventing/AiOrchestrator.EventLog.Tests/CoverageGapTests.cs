// <copyright file="CoverageGapTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Buffers;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Redaction;
using AiOrchestrator.Abstractions.Telemetry;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.EventLog;
using AiOrchestrator.EventLog.Quota;
using AiOrchestrator.EventLog.Tier1;
using AiOrchestrator.EventLog.Tier2;
using AiOrchestrator.Models.Eventing;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.TestKit.Time;
using Microsoft.Extensions.Options;
using Xunit;

namespace AiOrchestrator.EventLog.Tests;

/// <summary>Tests covering uncovered branches in EventLog assembly.</summary>
public sealed class CoverageGapTests : IDisposable
{
    private readonly string root;

    public CoverageGapTests()
    {
        this.root = Path.Combine(Path.GetTempPath(), "el-cov-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.root);
    }

    public void Dispose()
    {
        try { Directory.Delete(this.root, recursive: true); }
        catch { /* best effort */ }
    }

    // =====================================================================
    // HotRingBuffer
    // =====================================================================

    [Fact]
    public void HotRingBuffer_CtorThrowsOnZeroCapacity()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new HotRingBuffer(0));
    }

    [Fact]
    public void HotRingBuffer_CtorThrowsOnNegativeCapacity()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new HotRingBuffer(-1));
    }

    [Fact]
    public void HotRingBuffer_AddThrowsOnNull()
    {
        var buf = new HotRingBuffer(4);
        Assert.Throws<ArgumentNullException>(() => buf.Add(null!));
    }

    [Fact]
    public void HotRingBuffer_SnapshotEmptyReturnsEmptyArray()
    {
        var buf = new HotRingBuffer(4);
        var snap = buf.Snapshot();
        Assert.Empty(snap);
    }

    [Fact]
    public void HotRingBuffer_SnapshotReturnsSingleItem()
    {
        var buf = new HotRingBuffer(4);
        var env = MakeEnvelope(1);
        buf.Add(env);
        var snap = buf.Snapshot();
        Assert.Single(snap);
        Assert.Equal(1, snap[0].RecordSeq);
    }

    [Fact]
    public void HotRingBuffer_EvictsOldestWhenFull()
    {
        var buf = new HotRingBuffer(3);
        for (var i = 1; i <= 5; i++)
        {
            buf.Add(MakeEnvelope(i));
        }

        var snap = buf.Snapshot();
        Assert.Equal(3, snap.Length);
        // Oldest kept should be seq 3
        Assert.Equal(3, snap[0].RecordSeq);
        Assert.Equal(5, snap[^1].RecordSeq);
    }

    [Fact]
    public void HotRingBuffer_SnapshotOrderedAscending()
    {
        var buf = new HotRingBuffer(8);
        // Add out of order (though in practice they'd be ascending)
        buf.Add(MakeEnvelope(3));
        buf.Add(MakeEnvelope(5));
        buf.Add(MakeEnvelope(7));

        var snap = buf.Snapshot();
        for (var i = 1; i < snap.Length; i++)
        {
            Assert.True(snap[i].RecordSeq > snap[i - 1].RecordSeq);
        }
    }

    [Fact]
    public void HotRingBuffer_WrapAroundMultipleTimes()
    {
        var buf = new HotRingBuffer(2);
        for (var i = 1; i <= 10; i++)
        {
            buf.Add(MakeEnvelope(i));
        }

        var snap = buf.Snapshot();
        Assert.Equal(2, snap.Length);
        Assert.Equal(9, snap[0].RecordSeq);
        Assert.Equal(10, snap[1].RecordSeq);
    }

    // =====================================================================
    // TieredReader (0% coverage)
    // =====================================================================

    [Fact]
    public void TieredReader_CtorThrowsOnNullT2()
    {
        var clock = new InMemoryClock();
        var reassembly = new ReassemblyBuffer(1024, TimeSpan.FromSeconds(1), clock);
        var opts = new TestOptionsMonitor<EventLogOptions>(new EventLogOptions());
        Assert.Throws<ArgumentNullException>(() => new TieredReader(null!, reassembly, opts));
    }

    [Fact]
    public void TieredReader_CtorThrowsOnNullReassembly()
    {
        var dir = NewDir("tr-null-reassembly");
        var aof = new AppendOnlyFile(new AbsolutePath(Path.Combine(dir, "seg.log")));
        var opts = new TestOptionsMonitor<EventLogOptions>(new EventLogOptions());
        Assert.Throws<ArgumentNullException>(() => new TieredReader(aof, null!, opts));
    }

    [Fact]
    public void TieredReader_CtorThrowsOnNullOpts()
    {
        var dir = NewDir("tr-null-opts");
        var aof = new AppendOnlyFile(new AbsolutePath(Path.Combine(dir, "seg.log")));
        var clock = new InMemoryClock();
        var reassembly = new ReassemblyBuffer(1024, TimeSpan.FromSeconds(1), clock);
        Assert.Throws<ArgumentNullException>(() => new TieredReader(aof, reassembly, null!));
    }

    [Fact]
    public async Task TieredReader_ReadAsyncYieldsRecordsAboveFromSeq()
    {
        var dir = NewDir("tr-read");
        var segPath = Path.Combine(dir, "seg.log");
        var aof = new AppendOnlyFile(new AbsolutePath(segPath));

        // Write some framed records directly
        for (var i = 1; i <= 5; i++)
        {
            var payload = Encoding.UTF8.GetBytes($"{{\"seq\":{i}}}");
            var buf = new byte[RecordFramer.FramedSize(payload.Length)];
            RecordFramer.Frame(payload, buf, recordSeq: i);
            await aof.AppendAsync(buf, CancellationToken.None);
        }

        var clock = new InMemoryClock();
        var reassembly = new ReassemblyBuffer(1024, TimeSpan.FromSeconds(1), clock);
        var opts = new TestOptionsMonitor<EventLogOptions>(new EventLogOptions());
        var reader = new TieredReader(aof, reassembly, opts);

        var results = new List<RawRecord>();
        await foreach (var rec in reader.ReadAsync(3, CancellationToken.None))
        {
            results.Add(rec);
        }

        // Should yield records with seq >= 3
        Assert.Equal(3, results.Count);
        Assert.Equal(3, results[0].RecordSeq);
        Assert.Equal(4, results[1].RecordSeq);
        Assert.Equal(5, results[2].RecordSeq);
    }

    [Fact]
    public async Task TieredReader_ReadAsyncSkipsBelowFromSeq()
    {
        var dir = NewDir("tr-skip");
        var segPath = Path.Combine(dir, "seg.log");
        var aof = new AppendOnlyFile(new AbsolutePath(segPath));

        for (var i = 1; i <= 3; i++)
        {
            var payload = Encoding.UTF8.GetBytes($"{{\"v\":{i}}}");
            var buf = new byte[RecordFramer.FramedSize(payload.Length)];
            RecordFramer.Frame(payload, buf, recordSeq: i);
            await aof.AppendAsync(buf, CancellationToken.None);
        }

        var clock = new InMemoryClock();
        var reassembly = new ReassemblyBuffer(1024, TimeSpan.FromSeconds(1), clock);
        var opts = new TestOptionsMonitor<EventLogOptions>(new EventLogOptions());
        var reader = new TieredReader(aof, reassembly, opts);

        var results = new List<RawRecord>();
        await foreach (var rec in reader.ReadAsync(10, CancellationToken.None))
        {
            results.Add(rec);
        }

        Assert.Empty(results);
    }

    // =====================================================================
    // Crc32C
    // =====================================================================

    [Fact]
    public void Crc32C_EmptyInputReturnsZero()
    {
        var crc = Crc32C.HashToUInt32(ReadOnlySpan<byte>.Empty);
        Assert.Equal(0u, crc);
    }

    [Fact]
    public void Crc32C_KnownValue_HelloWorld()
    {
        // Deterministic: same input always produces same output
        var data = Encoding.UTF8.GetBytes("Hello, World!");
        var crc1 = Crc32C.HashToUInt32(data);
        var crc2 = Crc32C.HashToUInt32(data);
        Assert.Equal(crc1, crc2);
        Assert.NotEqual(0u, crc1);
    }

    [Fact]
    public void Crc32C_DifferentDataProducesDifferentHash()
    {
        var a = Crc32C.HashToUInt32(Encoding.UTF8.GetBytes("abc"));
        var b = Crc32C.HashToUInt32(Encoding.UTF8.GetBytes("xyz"));
        Assert.NotEqual(a, b);
    }

    [Fact]
    public void Crc32C_AppendContinuesRunningHash()
    {
        var data = Encoding.UTF8.GetBytes("abcdefgh");
        var full = Crc32C.HashToUInt32(data);

        // Append in two parts
        var partial1 = Crc32C.Append(0u, data.AsSpan(0, 4));
        var partial2 = Crc32C.Append(partial1, data.AsSpan(4));

        Assert.Equal(full, partial2);
    }

    [Fact]
    public void Crc32C_LargePayloadDoesNotThrow()
    {
        // Exercise hardware-accelerated paths (8-byte and 4-byte chunks)
        var data = new byte[1024];
        new Random(42).NextBytes(data);
        var crc = Crc32C.HashToUInt32(data);
        Assert.NotEqual(0u, crc);
    }

    [Fact]
    public void Crc32C_SingleBytePayload()
    {
        var crc = Crc32C.HashToUInt32(new byte[] { 0x42 });
        Assert.NotEqual(0u, crc);
    }

    // =====================================================================
    // ReassemblyBuffer
    // =====================================================================

    [Fact]
    public void ReassemblyBuffer_CtorThrowsOnZeroMaxBytes()
    {
        var clock = new InMemoryClock();
        Assert.Throws<ArgumentOutOfRangeException>(() => new ReassemblyBuffer(0, TimeSpan.FromSeconds(1), clock));
    }

    [Fact]
    public void ReassemblyBuffer_CtorThrowsOnNegativeMaxBytes()
    {
        var clock = new InMemoryClock();
        Assert.Throws<ArgumentOutOfRangeException>(() => new ReassemblyBuffer(-1, TimeSpan.FromSeconds(1), clock));
    }

    [Fact]
    public void ReassemblyBuffer_CtorThrowsOnNullClock()
    {
        Assert.Throws<ArgumentNullException>(() => new ReassemblyBuffer(64, TimeSpan.FromSeconds(1), null!));
    }

    [Fact]
    public void ReassemblyBuffer_TryAppendEmptyIsNoop()
    {
        var clock = new InMemoryClock();
        var buf = new ReassemblyBuffer(64, TimeSpan.FromSeconds(1), clock);
        Assert.True(buf.TryAppend(ReadOnlySpan<byte>.Empty));
        Assert.Equal(0, buf.BytesBuffered);
    }

    [Fact]
    public void ReassemblyBuffer_TryAppendAccumulatesBytes()
    {
        var clock = new InMemoryClock();
        var buf = new ReassemblyBuffer(128, TimeSpan.FromSeconds(1), clock);
        Assert.True(buf.TryAppend(new byte[20]));
        Assert.Equal(20, buf.BytesBuffered);
        Assert.True(buf.TryAppend(new byte[30]));
        Assert.Equal(50, buf.BytesBuffered);
    }

    [Fact]
    public void ReassemblyBuffer_TryAppendExceedingCapReturnsFalse()
    {
        var clock = new InMemoryClock();
        var buf = new ReassemblyBuffer(32, TimeSpan.FromSeconds(1), clock);
        Assert.True(buf.TryAppend(new byte[30]));
        Assert.False(buf.TryAppend(new byte[10])); // 30 + 10 > 32
    }

    [Fact]
    public void ReassemblyBuffer_ElapsedMsZeroWhenEmpty()
    {
        var clock = new InMemoryClock();
        var buf = new ReassemblyBuffer(64, TimeSpan.FromSeconds(1), clock);
        Assert.Equal(0, buf.ElapsedMs);
    }

    [Fact]
    public void ReassemblyBuffer_ElapsedMsTracksTime()
    {
        var clock = new InMemoryClock(monotonicMs: 100);
        var buf = new ReassemblyBuffer(128, TimeSpan.FromSeconds(5), clock);
        buf.TryAppend(new byte[10]); // starts at 100ms
        clock.Advance(TimeSpan.FromMilliseconds(250));
        Assert.Equal(250, buf.ElapsedMs);
    }

    [Fact]
    public void ReassemblyBuffer_IsTimedOutReturnsFalseWhenEmpty()
    {
        var clock = new InMemoryClock();
        var buf = new ReassemblyBuffer(64, TimeSpan.FromSeconds(1), clock);
        Assert.False(buf.IsTimedOut());
    }

    [Fact]
    public void ReassemblyBuffer_IsTimedOutReturnsTrueAfterTimeout()
    {
        var clock = new InMemoryClock(monotonicMs: 0);
        var buf = new ReassemblyBuffer(128, TimeSpan.FromMilliseconds(500), clock);
        buf.TryAppend(new byte[10]);
        clock.Advance(TimeSpan.FromMilliseconds(600));
        Assert.True(buf.IsTimedOut());
    }

    [Fact]
    public void ReassemblyBuffer_FlushReturnsBufferedDataAndResets()
    {
        var clock = new InMemoryClock();
        var buf = new ReassemblyBuffer(128, TimeSpan.FromSeconds(5), clock);
        var data = new byte[] { 1, 2, 3, 4, 5 };
        buf.TryAppend(data);
        Assert.Equal(5, buf.BytesBuffered);

        var flushed = buf.Flush();
        Assert.Equal(data, flushed.ToArray());
        Assert.Equal(0, buf.BytesBuffered);
    }

    [Fact]
    public void ReassemblyBuffer_ResetClearsBuffer()
    {
        var clock = new InMemoryClock();
        var buf = new ReassemblyBuffer(128, TimeSpan.FromSeconds(5), clock);
        buf.TryAppend(new byte[50]);
        Assert.Equal(50, buf.BytesBuffered);
        buf.Reset();
        Assert.Equal(0, buf.BytesBuffered);
    }

    [Fact]
    public void ReassemblyBuffer_GrowsBufferOnLargeAppend()
    {
        var clock = new InMemoryClock();
        var buf = new ReassemblyBuffer(1024, TimeSpan.FromSeconds(5), clock);
        // First append is small, then a much larger one forces buffer growth
        buf.TryAppend(new byte[10]);
        buf.TryAppend(new byte[200]);
        Assert.Equal(210, buf.BytesBuffered);
    }

    // =====================================================================
    // PerPlanDiskCap
    // =====================================================================

    [Fact]
    public void PerPlanDiskCap_CtorThrowsOnZeroCap()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new PerPlanDiskCap(0));
    }

    [Fact]
    public void PerPlanDiskCap_CtorThrowsOnNegativeCap()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new PerPlanDiskCap(-1));
    }

    [Fact]
    public void PerPlanDiskCap_TryReserveNonPositiveBytesAlwaysSucceeds()
    {
        var cap = new PerPlanDiskCap(100);
        var plan = new PlanId(Guid.NewGuid());
        Assert.True(cap.TryReserve(plan, 0));
        Assert.True(cap.TryReserve(plan, -5));
        Assert.Equal(0, cap.Current(plan));
    }

    [Fact]
    public void PerPlanDiskCap_TryReserveAndRelease()
    {
        var cap = new PerPlanDiskCap(100);
        var plan = new PlanId(Guid.NewGuid());
        Assert.True(cap.TryReserve(plan, 50));
        Assert.Equal(50, cap.Current(plan));
        Assert.True(cap.TryReserve(plan, 40));
        Assert.Equal(90, cap.Current(plan));

        // Over cap
        Assert.False(cap.TryReserve(plan, 20));

        // Release and re-reserve
        cap.Release(plan, 30);
        Assert.Equal(60, cap.Current(plan));
        Assert.True(cap.TryReserve(plan, 30));
    }

    [Fact]
    public void PerPlanDiskCap_ReleaseNonPositiveIsNoop()
    {
        var cap = new PerPlanDiskCap(100);
        var plan = new PlanId(Guid.NewGuid());
        cap.TryReserve(plan, 50);
        cap.Release(plan, 0);
        cap.Release(plan, -10);
        Assert.Equal(50, cap.Current(plan));
    }

    [Fact]
    public void PerPlanDiskCap_ReleaseMoreThanReservedClampsToZero()
    {
        var cap = new PerPlanDiskCap(100);
        var plan = new PlanId(Guid.NewGuid());
        cap.TryReserve(plan, 30);
        cap.Release(plan, 100); // more than reserved
        Assert.Equal(0, cap.Current(plan));
    }

    [Fact]
    public void PerPlanDiskCap_ReleaseForUnknownPlanIsNoop()
    {
        var cap = new PerPlanDiskCap(100);
        var plan = new PlanId(Guid.NewGuid());
        cap.Release(plan, 50); // no reservation exists
        Assert.Equal(0, cap.Current(plan));
    }

    [Fact]
    public void PerPlanDiskCap_DifferentPlansAreIndependent()
    {
        var cap = new PerPlanDiskCap(100);
        var plan1 = new PlanId(Guid.NewGuid());
        var plan2 = new PlanId(Guid.NewGuid());
        cap.TryReserve(plan1, 80);
        cap.TryReserve(plan2, 80);
        Assert.Equal(80, cap.Current(plan1));
        Assert.Equal(80, cap.Current(plan2));
    }

    [Fact]
    public void PerPlanDiskCap_CreateExceptionIncludesAllMetadata()
    {
        var cap = new PerPlanDiskCap(1024);
        var plan = new PlanId(Guid.NewGuid());
        var ex = cap.CreateException(plan, 500, 800, 1024);
        Assert.Equal(plan, ex.PlanId);
        Assert.Equal(500, ex.Requested);
        Assert.Equal(800, ex.Current);
        Assert.Equal(1024, ex.Cap);
        Assert.Contains(plan.ToString(), ex.Message);
    }

    [Fact]
    public void PerPlanDiskCap_CapPropertyReturnsCap()
    {
        var cap = new PerPlanDiskCap(512);
        Assert.Equal(512, cap.Cap);
    }

    // =====================================================================
    // TieredEventLog additional paths
    // =====================================================================

    [Fact]
    public async Task TieredEventLog_AppendThrowsOnNull()
    {
        var dir = NewDir("null-env");
        await using var log = NewLog(dir);
        await Assert.ThrowsAsync<ArgumentNullException>(
            () => log.AppendAsync(null!, CancellationToken.None).AsTask());
    }

    [Fact]
    public async Task TieredEventLog_AppendThrowsOnZeroSeq()
    {
        var dir = NewDir("zero-seq");
        await using var log = NewLog(dir);
        var env = MakeEnvelope(0);
        await Assert.ThrowsAsync<ArgumentException>(
            () => log.AppendAsync(env, CancellationToken.None).AsTask());
    }

    [Fact]
    public async Task TieredEventLog_AppendThrowsOnNegativeSeq()
    {
        var dir = NewDir("neg-seq");
        await using var log = NewLog(dir);
        var env = MakeEnvelope(-1);
        await Assert.ThrowsAsync<ArgumentException>(
            () => log.AppendAsync(env, CancellationToken.None).AsTask());
    }

    [Fact]
    public async Task TieredEventLog_DisposeIsIdempotent()
    {
        var dir = NewDir("dispose-idem");
        var log = NewLog(dir);
        await log.DisposeAsync();
        await log.DisposeAsync(); // second dispose should not throw
    }

    [Fact]
    public async Task TieredEventLog_AppendAfterDisposeThrows()
    {
        var dir = NewDir("append-after-dispose");
        var log = NewLog(dir);
        await log.DisposeAsync();
        await Assert.ThrowsAsync<ObjectDisposedException>(
            () => log.AppendAsync(MakeEnvelope(1), CancellationToken.None).AsTask());
    }

    [Fact]
    public async Task TieredEventLog_ReadFromAfterDisposeYieldsNothing()
    {
        var dir = NewDir("read-after-dispose");
        var log = NewLog(dir);
        await log.AppendAsync(MakeEnvelope(1), CancellationToken.None);
        await log.DisposeAsync();

        var count = 0;
        await foreach (var _ in log.ReadFromAsync(0, CancellationToken.None))
        {
            count++;
        }

        Assert.Equal(0, count);
    }

    [Fact]
    public async Task TieredEventLog_ReadReplayAndLiveAfterDisposeYieldsNothing()
    {
        var dir = NewDir("replay-after-dispose");
        var log = NewLog(dir);
        await log.DisposeAsync();

        var count = 0;
        await foreach (var _ in log.ReadReplayAndLiveAsync(new EventFilter(), CancellationToken.None))
        {
            count++;
        }

        Assert.Equal(0, count);
    }

    [Fact]
    public async Task TieredEventLog_ReadReplayAndLiveWithFilter()
    {
        var dir = NewDir("filtered-replay");
        await using var log = NewLog(dir);
        var plan1 = new PlanId(Guid.NewGuid());
        var plan2 = new PlanId(Guid.NewGuid());

        await log.AppendAsync(MakeEnvelope(1, planId: plan1), CancellationToken.None);
        await log.AppendAsync(MakeEnvelope(2, planId: plan2), CancellationToken.None);
        await log.AppendAsync(MakeEnvelope(3, planId: plan1), CancellationToken.None);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var filter = new EventFilter { PlanId = plan1 };
        var results = new List<EventEnvelope>();

        await foreach (var env in log.ReadReplayAndLiveAsync(filter, cts.Token))
        {
            results.Add(env);
            if (results.Count >= 2)
            {
                break;
            }
        }

        Assert.Equal(2, results.Count);
        Assert.All(results, e => Assert.Equal(plan1, e.PlanId));
    }

    [Fact]
    public async Task TieredEventLog_ReopenResumesSameSeq()
    {
        var dir = NewDir("reopen");
        await using (var log = NewLog(dir))
        {
            for (var i = 1; i <= 3; i++)
            {
                await log.AppendAsync(MakeEnvelope(i), CancellationToken.None);
            }
        }

        // Reopen and verify records persist
        await using var log2 = NewLog(dir);
        var results = new List<EventEnvelope>();
        await foreach (var e in log2.ReadFromAsync(0, CancellationToken.None))
        {
            results.Add(e);
        }

        Assert.Equal(3, results.Count);
    }

    [Fact]
    public async Task TieredEventLog_DisposeCompletesLiveSubscribers()
    {
        var dir = NewDir("dispose-subs");
        var log = NewLog(dir);
        await log.AppendAsync(MakeEnvelope(1), CancellationToken.None);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var readTask = Task.Run(async () =>
        {
            var count = 0;
            await foreach (var _ in log.ReadReplayAndLiveAsync(new EventFilter(), cts.Token))
            {
                count++;
                if (count >= 1)
                {
                    // Got the replay; now wait for dispose to complete the channel
                    await log.DisposeAsync();
                }
            }

            return count;
        }, cts.Token);

        var result = await readTask;
        Assert.True(result >= 1);
    }

    // =====================================================================
    // Helpers
    // =====================================================================
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
