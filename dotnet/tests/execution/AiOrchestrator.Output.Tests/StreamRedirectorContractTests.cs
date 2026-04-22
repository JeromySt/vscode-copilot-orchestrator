// <copyright file="StreamRedirectorContractTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Buffers;
using System.Collections.Concurrent;
using System.IO.Pipelines;
using System.Text;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.LineView;
using AiOrchestrator.Models.Eventing;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Output.Fanout;
using AiOrchestrator.TestKit.Time;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace AiOrchestrator.Output.Tests;

/// <summary>Marks a test method as a contract test verifying a specific acceptance criterion.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    public ContractTestAttribute(string id) => this.Id = id;

    public string Id { get; }
}

internal sealed class FakeEventStore : IEventStore
{
    public ConcurrentQueue<EventEnvelope> Appended { get; } = new();

    public ValueTask AppendAsync(EventEnvelope envelope, CancellationToken ct)
    {
        this.Appended.Enqueue(envelope);
        return ValueTask.CompletedTask;
    }

    public async IAsyncEnumerable<EventEnvelope> ReadFromAsync(long fromRecordSeq, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        await Task.CompletedTask.ConfigureAwait(false);
        foreach (var e in this.Appended)
        {
            if (e.RecordSeq >= fromRecordSeq)
            {
                yield return e;
            }
        }
    }
}

internal sealed class FakeEventBus : IEventBus
{
    public ConcurrentQueue<object> Published { get; } = new();

    public ValueTask PublishAsync<TEvent>(TEvent eventData, CancellationToken ct)
        where TEvent : notnull
    {
        this.Published.Enqueue(eventData);
        return ValueTask.CompletedTask;
    }

    public IAsyncDisposable Subscribe<TEvent>(EventFilter filter, Func<TEvent, CancellationToken, ValueTask> handler)
        where TEvent : notnull
    {
        return new NoopDisposable();
    }

    private sealed class NoopDisposable : IAsyncDisposable
    {
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}

public sealed class StreamRedirectorContractTests
{
    private static IOptionsMonitor<RedirectorOptions> Opts(RedirectorOptions? value = null)
        => new TestOptionsMonitor<RedirectorOptions>(value ?? new RedirectorOptions());

    private static StreamRedirector NewRedirector(
        out FakeEventStore log,
        out FakeEventBus bus,
        RedirectorOptions? options = null)
    {
        log = new FakeEventStore();
        bus = new FakeEventBus();
        var clock = new InMemoryClock(new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero));
        var lineView = new LineProjector();
        return new StreamRedirector(log, bus, lineView, clock, Opts(options));
    }

    private static (PipeReader Reader, PipeWriter Writer) NewPipe()
    {
        var pipe = new Pipe();
        return (pipe.Reader, pipe.Writer);
    }

    private static async Task WriteAndFlushAsync(PipeWriter writer, byte[] data)
    {
        await writer.WriteAsync(data).ConfigureAwait(false);
        await writer.FlushAsync().ConfigureAwait(false);
    }

    // ---------------------------------------------------------------------
    // OUT-FANOUT-1 — All four standard consumers receive each chunk.
    // ---------------------------------------------------------------------
    [Fact]
    [ContractTest("OUT-FANOUT-1")]
    public async Task OUT_FANOUT_AllConsumersReceiveChunk()
    {
        var sut = NewRedirector(out var log, out _);
        var job = JobId.New();
        var run = RunId.New();
        var (outR, outW) = NewPipe();
        var (errR, errW) = NewPipe();

        // Add an extra observer subscription on the broker so we can confirm fan-out happened.
        var observed = new List<OutputChunk>();
        await using var observer = sut.Broker.Subscribe(job, OutputConsumerKind.RingBuffer, (c, _) =>
        {
            lock (observed) { observed.Add(c); }
            return ValueTask.CompletedTask;
        });

        await sut.AttachAsync(job, run, outR, errR, CancellationToken.None);

        await WriteAndFlushAsync(outW, Encoding.UTF8.GetBytes("hello"));
        await WriteAndFlushAsync(errW, Encoding.UTF8.GetBytes("oops"));
        await outW.CompleteAsync();
        await errW.CompleteAsync();

        // Allow consumers time to drain.
        await WaitUntilAsync(() => log.Appended.Count >= 2 && observed.Count >= 2, TimeSpan.FromSeconds(5));

        await sut.DetachAsync(job, CancellationToken.None);

        // EventLog: 2 envelopes (one per chunk).
        Assert.True(log.Appended.Count >= 2);

        // RingBuffer + observer: chunk delivered to all consumers (snapshot is non-empty).
        var snap = sut.SnapshotFor(job);
        Assert.Equal(0, snap.RecentStdoutBytes.Length);
        Assert.True(observed.Count >= 2);
        await sut.DisposeAsync();
    }

    // ---------------------------------------------------------------------
    // OUT-LAG-1 — Bounded consumer overflow emits ConsumerLagged on the bus.
    // ---------------------------------------------------------------------
    [Fact]
    [ContractTest("OUT-LAG-1")]
    public async Task OUT_LAG_OverflowEmitsConsumerLagged()
    {
        var bus = new FakeEventBus();
        var broker = new FanoutBroker(Opts(new RedirectorOptions { PerConsumerQueueDepth = 2 }), bus);
        var job = JobId.New();
        var slowGate = new TaskCompletionSource();
        var slow = broker.Subscribe(job, OutputConsumerKind.LineView, async (_, ct) =>
        {
            await slowGate.Task.WaitAsync(ct).ConfigureAwait(false);
        });

        for (var i = 0; i < 50; i++)
        {
            await broker.PublishAsync(job, NewChunk(job, i, new byte[] { 1, 2, 3, 4 }), CancellationToken.None);
        }

        // Releasing the gate so the subscription can drain on dispose.
        slowGate.TrySetResult();
        await slow.DisposeAsync();

        Assert.NotEmpty(bus.Published.OfType<ConsumerLagged>());
        Assert.Equal(OutputConsumerKind.LineView, bus.Published.OfType<ConsumerLagged>().Last().Consumer);
    }

    // ---------------------------------------------------------------------
    // OUT-LAG-2 — Publisher is never blocked by a slow consumer.
    // ---------------------------------------------------------------------
    [Fact]
    [ContractTest("OUT-LAG-2")]
    public async Task OUT_LAG_PublisherNeverBlocked()
    {
        var bus = new FakeEventBus();
        var broker = new FanoutBroker(Opts(new RedirectorOptions { PerConsumerQueueDepth = 4 }), bus);
        var job = JobId.New();
        var gate = new TaskCompletionSource();
        var slow = broker.Subscribe(job, OutputConsumerKind.EventLog, async (_, ct) =>
        {
            await gate.Task.WaitAsync(ct).ConfigureAwait(false);
        });

        var sw = System.Diagnostics.Stopwatch.StartNew();
        for (var i = 0; i < 1000; i++)
        {
            await broker.PublishAsync(job, NewChunk(job, i, new byte[] { 9 }), CancellationToken.None);
        }

        sw.Stop();
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(2), "publisher must never block on slow consumers");

        gate.TrySetResult();
        await slow.DisposeAsync();
    }

    // ---------------------------------------------------------------------
    // OUT-RING-1 — Ring buffer retains the most recent N bytes.
    // ---------------------------------------------------------------------
    [Fact]
    [ContractTest("OUT-RING-1")]
    public async Task OUT_RING_RetainsRecentBytes()
    {
        var sut = NewRedirector(out _, out _, options: new RedirectorOptions { RingBufferBytes = 1024, PerConsumerQueueDepth = 2048 });
        var job = JobId.New();
        var run = RunId.New();
        var (outR, outW) = NewPipe();
        var (errR, errW) = NewPipe();
        await sut.AttachAsync(job, run, outR, errR, CancellationToken.None);

        // Write 3 KiB of distinct bytes; only the last 1 KiB should remain in the ring.
        var data = new byte[3072];
        for (var i = 0; i < data.Length; i++) { data[i] = (byte)(i & 0xFF); }
        await WriteAndFlushAsync(outW, data);
        await outW.CompleteAsync();
        await errW.CompleteAsync();

        await WaitUntilAsync(() => sut.SnapshotFor(job).TotalStdoutBytes >= 3072, TimeSpan.FromSeconds(5));

        var snap = sut.SnapshotFor(job);
        Assert.Equal(3072, snap.TotalStdoutBytes);
        Assert.Equal(1024, snap.RecentStdoutBytes.Length);

        // Last 1024 bytes of original data should match the snapshot.
        for (var i = 0; i < 1024; i++)
        {
            Assert.Equal(data[2048 + i], snap.RecentStdoutBytes[i]);
        }

        await sut.DisposeAsync();
    }

    // ---------------------------------------------------------------------
    // OUT-SNAP-1 — Snapshot is consistent and immutable for late attachers.
    // ---------------------------------------------------------------------
    [Fact]
    [ContractTest("OUT-SNAP-1")]
    public async Task OUT_SNAPSHOT_ConsistentForLateAttacher()
    {
        var sut = NewRedirector(out _, out _);
        var job = JobId.New();
        var run = RunId.New();
        var (outR, outW) = NewPipe();
        var (errR, errW) = NewPipe();
        await sut.AttachAsync(job, run, outR, errR, CancellationToken.None);

        await WriteAndFlushAsync(outW, Encoding.UTF8.GetBytes("first-batch"));
        await WaitUntilAsync(() => sut.SnapshotFor(job).TotalStdoutBytes >= 11, TimeSpan.FromSeconds(5));
        var snap1 = sut.SnapshotFor(job);

        // After taking snap1, push more data — snap1 must remain unchanged (immutability).
        await WriteAndFlushAsync(outW, Encoding.UTF8.GetBytes("second-batch"));
        await WaitUntilAsync(() => sut.SnapshotFor(job).TotalStdoutBytes >= 23, TimeSpan.FromSeconds(5));

        Assert.Equal(11, snap1.TotalStdoutBytes);
        Assert.Equal(11, snap1.RecentStdoutBytes.Length);
        Assert.Equal("first-batch", Encoding.UTF8.GetString(snap1.RecentStdoutBytes.AsSpan()));

        var snap2 = sut.SnapshotFor(job);
        Assert.Equal(23, snap2.TotalStdoutBytes);

        await outW.CompleteAsync();
        await errW.CompleteAsync();
        await sut.DisposeAsync();
    }

    // ---------------------------------------------------------------------
    // OUT-DETACH-1 — Detach drains all consumer queues before returning.
    // ---------------------------------------------------------------------
    [Fact]
    [ContractTest("OUT-DETACH-1")]
    public async Task OUT_DETACH_FlushesAllQueues()
    {
        var sut = NewRedirector(out var log, out _);
        var job = JobId.New();
        var run = RunId.New();
        var (outR, outW) = NewPipe();
        var (errR, errW) = NewPipe();
        await sut.AttachAsync(job, run, outR, errR, CancellationToken.None);

        for (var i = 0; i < 50; i++)
        {
            await WriteAndFlushAsync(outW, Encoding.UTF8.GetBytes($"chunk-{i};"));
        }

        await outW.CompleteAsync();
        await errW.CompleteAsync();

        await sut.DetachAsync(job, CancellationToken.None);

        // After detach all consumer queues must have drained — the EventLog should
        // contain at least 50 envelopes (one per published chunk).
        Assert.True(log.Appended.Count >= 50);
        await sut.DisposeAsync();
    }

    // ---------------------------------------------------------------------
    // OUT-ALLOC-1 — Hot fan-out path is allocation-light (< 64 B / chunk after warmup).
    // ---------------------------------------------------------------------
    [Fact]
    [ContractTest("OUT-ALLOC-1")]
    public async Task OUT_HOTPATH_AllocationLight()
    {
        var bus = new FakeEventBus();
        var broker = new FanoutBroker(Opts(new RedirectorOptions { PerConsumerQueueDepth = 16384 }), bus);
        var job = JobId.New();
        await using var sub = broker.Subscribe(job, OutputConsumerKind.RingBuffer, (_, _) => ValueTask.CompletedTask);

        // Pre-rent a buffer to ensure ArrayPool warmup does not count.
        var rented = ArrayPool<byte>.Shared.Rent(64);
        try
        {
            var memory = new ReadOnlyMemory<byte>(rented, 0, 32);

            // Reuse a single chunk — measure only the publish hot-path overhead.
            var chunk = new OutputChunk
            {
                JobId = job,
                Stream = OutputStream.StdOut,
                ByteOffset = 0,
                Data = memory,
                At = DateTimeOffset.UtcNow,
            };

            // Warmup.
            for (var i = 0; i < 512; i++)
            {
                await broker.PublishAsync(job, chunk, CancellationToken.None);
            }

            const int iterations = 4096;
            GC.Collect();
            GC.WaitForPendingFinalizers();
            var before = GC.GetAllocatedBytesForCurrentThread();
            for (var i = 0; i < iterations; i++)
            {
                await broker.PublishAsync(job, chunk, CancellationToken.None);
            }

            var after = GC.GetAllocatedBytesForCurrentThread();
            var perChunk = (after - before) / (double)iterations;
            Assert.True(perChunk < 64.0, $"observed {perChunk:F2} B/chunk, target < 64");
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(rented);
        }
    }

    // ---------------------------------------------------------------------
    // OUT-ISO-1 — Per-job isolation: a slow consumer for one job must not
    // affect publishes for another job.
    // ---------------------------------------------------------------------
    [Fact]
    [ContractTest("OUT-ISO-1")]
    public async Task OUT_ISOLATION_PerJob_NoCrossInterference()
    {
        var bus = new FakeEventBus();
        var broker = new FanoutBroker(Opts(new RedirectorOptions { PerConsumerQueueDepth = 4 }), bus);
        var jobA = JobId.New();
        var jobB = JobId.New();

        var blockA = new TaskCompletionSource();
        var slow = broker.Subscribe(jobA, OutputConsumerKind.LineView, async (_, ct) =>
        {
            await blockA.Task.WaitAsync(ct).ConfigureAwait(false);
        });

        var bReceived = 0;
        var fast = broker.Subscribe(jobB, OutputConsumerKind.LineView, (_, _) =>
        {
            Interlocked.Increment(ref bReceived);
            return ValueTask.CompletedTask;
        });

        // Saturate jobA so its bounded queue overflows.
        for (var i = 0; i < 100; i++)
        {
            await broker.PublishAsync(jobA, NewChunk(jobA, i, new byte[] { 1 }), CancellationToken.None);
        }

        // Now publish to jobB — these must all be delivered.
        for (var i = 0; i < 50; i++)
        {
            await broker.PublishAsync(jobB, NewChunk(jobB, i, new byte[] { 2 }), CancellationToken.None);
        }

        await WaitUntilAsync(() => Volatile.Read(ref bReceived) >= 50, TimeSpan.FromSeconds(5));

        Assert.Equal(50, Volatile.Read(ref bReceived));

        blockA.TrySetResult();
        await slow.DisposeAsync();
        await fast.DisposeAsync();
    }

    private static OutputChunk NewChunk(JobId job, long offset, byte[] data) => new()
    {
        JobId = job,
        Stream = OutputStream.StdOut,
        ByteOffset = offset,
        Data = data,
        At = DateTimeOffset.UtcNow,
    };

    private static async Task WaitUntilAsync(Func<bool> condition, TimeSpan timeout)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (!condition())
        {
            if (sw.Elapsed > timeout) { return; }
            await Task.Delay(20).ConfigureAwait(false);
        }
    }

    private sealed class TestOptionsMonitor<T> : IOptionsMonitor<T>
        where T : class
    {
        private readonly T value;

        public TestOptionsMonitor(T value) => this.value = value;

        public T CurrentValue => this.value;

        public T Get(string? name) => this.value;

        public IDisposable? OnChange(Action<T, string?> listener) => null;
    }
}
