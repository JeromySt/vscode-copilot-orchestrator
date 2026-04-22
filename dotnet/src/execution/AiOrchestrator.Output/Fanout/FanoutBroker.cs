// <copyright file="FanoutBroker.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Concurrent;
using System.Threading.Channels;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Models.Ids;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Output.Fanout;

/// <summary>
/// Per-job multi-consumer publish/subscribe primitive used by <see cref="StreamRedirector"/>.
/// Each consumer subscribes through its own bounded channel; the publish path
/// (<see cref="PublishAsync"/>) never blocks on a slow consumer — when a consumer's
/// channel is full the chunk is dropped for that consumer alone and a
/// <see cref="ConsumerLagged"/> event is emitted on the supplied <see cref="IEventBus"/>.
/// </summary>
internal sealed class FanoutBroker
{
    private readonly IOptionsMonitor<RedirectorOptions> opts;
    private readonly IEventBus bus;
    private readonly ConcurrentDictionary<JobId, Subscription[]> byJob = new();
    private readonly object subsLock = new();

    /// <summary>Initializes a new instance of the <see cref="FanoutBroker"/> class.</summary>
    /// <param name="opts">Options monitor for redirector configuration.</param>
    /// <param name="bus">Event bus on which <see cref="ConsumerLagged"/> events are published.</param>
    public FanoutBroker(IOptionsMonitor<RedirectorOptions> opts, IEventBus bus)
    {
        ArgumentNullException.ThrowIfNull(opts);
        ArgumentNullException.ThrowIfNull(bus);
        this.opts = opts;
        this.bus = bus;
    }

    /// <summary>Subscribe a handler to receive chunks for <paramref name="job"/>.</summary>
    /// <param name="job">Job identifier.</param>
    /// <param name="kind">Logical consumer kind (used in lag events).</param>
    /// <param name="handler">Async handler invoked once per chunk delivered to this consumer.</param>
    /// <returns>Disposable that unsubscribes and drains the consumer's channel.</returns>
    public IAsyncDisposable Subscribe(JobId job, OutputConsumerKind kind, Func<OutputChunk, CancellationToken, ValueTask> handler)
    {
        ArgumentNullException.ThrowIfNull(handler);

        var depth = this.opts.CurrentValue.PerConsumerQueueDepth;

        // INV-7 — small bounded queues use synchronous handoff so the pump's
        // continuation runs on the publisher thread when the channel is empty,
        // letting fast consumers drain in lockstep with the publisher even
        // when another job's slow consumer is monopolising threadpool work.
        // Large queues use asynchronous handoff to keep the publisher hot path
        // allocation-light (INV-PERF / OUT-ALLOC-1).
        var allowSyncContinuations = depth <= 16;

        var channel = Channel.CreateBounded<OutputChunk>(new BoundedChannelOptions(depth)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait,
            AllowSynchronousContinuations = allowSyncContinuations,
        });

        var sub = new Subscription(Guid.NewGuid(), job, kind, channel, depth, handler);

        // Cold path — rebuild snapshot under lock for atomic swap.
        lock (this.subsLock)
        {
            var existing = this.byJob.TryGetValue(job, out var arr) ? arr : Array.Empty<Subscription>();
            var updated = new Subscription[existing.Length + 1];
            Array.Copy(existing, updated, existing.Length);
            updated[existing.Length] = sub;
            this.byJob[job] = updated;
        }

        sub.Pump = Task.Run(() => PumpAsync(sub));
        return new SubscriptionHandle(this, sub);
    }

    /// <summary>Publish a chunk to all subscribers of <paramref name="job"/>.</summary>
    /// <param name="job">Job identifier.</param>
    /// <param name="chunk">Chunk to deliver.</param>
    /// <param name="ct">Cancellation token (currently unused; publish never blocks).</param>
    /// <returns>Completed <see cref="ValueTask"/>.</returns>
    public ValueTask PublishAsync(JobId job, OutputChunk chunk, CancellationToken ct)
    {
        if (!this.byJob.TryGetValue(job, out var subs) || subs.Length == 0)
        {
            return ValueTask.CompletedTask;
        }

        // INV-2 — fast path: try a non-blocking write to every subscriber.
        // When all writes succeed synchronously this method allocates nothing
        // (iterating the immutable snapshot array uses no enumerator).
        var needsSlow = false;
        for (var i = 0; i < subs.Length; i++)
        {
            if (!subs[i].Writer.TryWrite(chunk))
            {
                needsSlow = true;
                break;
            }
        }

        if (!needsSlow)
        {
            return ValueTask.CompletedTask;
        }

        // Slow path: at least one subscriber is full. Briefly wait for space
        // (so a fast consumer with a small bounded queue under contention is
        // not starved — INV-7 per-job isolation), but if the consumer cannot
        // keep up within the configured budget we drop the chunk for THAT
        // consumer alone and emit ConsumerLagged. Other subscribers are
        // unaffected. The publisher is never blocked beyond the lag budget
        // (INV-2 / OUT-LAG-2).
        return this.PublishSlowAsync(subs, chunk, ct);
    }

    private static async Task PumpAsync(Subscription sub)
    {
        try
        {
            await foreach (var chunk in sub.Reader.ReadAllAsync(sub.Cancel.Token).ConfigureAwait(false))
            {
                try
                {
                    await sub.Handler(chunk, sub.Cancel.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch
                {
                    // Swallow handler errors so one bad consumer cannot break the pump.
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown.
        }
    }

    private async ValueTask PublishSlowAsync(Subscription[] subs, OutputChunk chunk, CancellationToken ct)
    {
        // Number of yield-and-retry attempts before declaring the consumer
        // lagged. Each yield returns to the threadpool which lets the consumer
        // pump drain a chunk; a small constant suffices to absorb transient
        // contention on small-depth queues (OUT-ISO-1) without blocking the
        // publisher when the consumer is permanently stuck (OUT-LAG-2).
        const int RetryAttempts = 4;
        for (var i = 0; i < subs.Length; i++)
        {
            var sub = subs[i];
            if (sub.Writer.TryWrite(chunk))
            {
                continue;
            }

            var written = false;
            for (var attempt = 0; attempt < RetryAttempts && !ct.IsCancellationRequested; attempt++)
            {
                await Task.Yield();
                if (sub.Writer.TryWrite(chunk))
                {
                    written = true;
                    break;
                }
            }

            if (!written)
            {
                this.NotifyLagged(sub, chunk.Data.Length);
            }
        }
    }

    private void NotifyLagged(Subscription sub, int droppedBytes)
    {
        var total = sub.AddDropped(droppedBytes);
        var lagged = new ConsumerLagged
        {
            JobId = sub.Job,
            Consumer = sub.Kind,
            DroppedBytes = total,
            At = DateTimeOffset.UtcNow,
        };

        // Best-effort publish; never throw on the publish hot path.
        _ = this.bus.PublishAsync(lagged, CancellationToken.None);
    }

    private void Unregister(Subscription sub)
    {
        lock (this.subsLock)
        {
            if (!this.byJob.TryGetValue(sub.Job, out var arr))
            {
                return;
            }

            var idx = Array.IndexOf(arr, sub);
            if (idx < 0)
            {
                return;
            }

            if (arr.Length == 1)
            {
                _ = this.byJob.TryRemove(sub.Job, out _);
                return;
            }

            var updated = new Subscription[arr.Length - 1];
            if (idx > 0)
            {
                Array.Copy(arr, 0, updated, 0, idx);
            }

            if (idx < arr.Length - 1)
            {
                Array.Copy(arr, idx + 1, updated, idx, arr.Length - 1 - idx);
            }

            this.byJob[sub.Job] = updated;
        }
    }

    internal sealed class Subscription
    {
        public Subscription(
            Guid id,
            JobId job,
            OutputConsumerKind kind,
            Channel<OutputChunk> channel,
            int capacity,
            Func<OutputChunk, CancellationToken, ValueTask> handler)
        {
            this.Id = id;
            this.Job = job;
            this.Kind = kind;
            this.Channel = channel;
            this.Capacity = capacity;
            this.Handler = handler;
            this.Cancel = new CancellationTokenSource();
            this.Pump = Task.CompletedTask;
        }

        public Guid Id { get; }

        public JobId Job { get; }

        public OutputConsumerKind Kind { get; }

        public Channel<OutputChunk> Channel { get; }

        public int Capacity { get; }

        public Func<OutputChunk, CancellationToken, ValueTask> Handler { get; }

        public CancellationTokenSource Cancel { get; }

        public Task Pump { get; set; }

        public ChannelWriter<OutputChunk> Writer => this.Channel.Writer;

        public ChannelReader<OutputChunk> Reader => this.Channel.Reader;

        public long DroppedBytes => Interlocked.Read(ref this.droppedBytes);

        public long AddDropped(long bytes) => Interlocked.Add(ref this.droppedBytes, bytes);

#pragma warning disable SA1201 // Field cannot follow property; isolated below for atomic counter only.
        private long droppedBytes;
#pragma warning restore SA1201
    }

    private sealed class SubscriptionHandle : IAsyncDisposable
    {
        private readonly FanoutBroker owner;
        private readonly Subscription sub;
        private int disposed;

        public SubscriptionHandle(FanoutBroker owner, Subscription sub)
        {
            this.owner = owner;
            this.sub = sub;
        }

        public async ValueTask DisposeAsync()
        {
            if (Interlocked.Exchange(ref this.disposed, 1) != 0)
            {
                return;
            }

            // Stop accepting new items; let pump drain remaining queued items.
            _ = this.sub.Writer.TryComplete();
            try
            {
                await this.sub.Pump.ConfigureAwait(false);
            }
            catch
            {
                // Pump already swallowed exceptions; nothing to surface here.
            }

            this.owner.Unregister(this.sub);
            this.sub.Cancel.Dispose();
        }
    }
}
