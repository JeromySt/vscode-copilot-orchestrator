// <copyright file="EventBus.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Concurrent;
using System.Reflection;
using System.Threading.Channels;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Redaction;
using AiOrchestrator.Abstractions.Time;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Eventing;

/// <summary>
/// In-process publish/subscribe bus over <see cref="Channel{T}"/>. Provides
/// authorisation-aware filter pinning (EVT-AUTH-1/2/3), redactor-applied payload
/// rewriting (INV-3), bounded backpressure with named queue stats (INV-5),
/// optional dedup-by-event-key (INV-4, CONC-CHAN-2), graceful subscription drain
/// (INV-6, INV-8), and zero locks on the publish hot path (INV-7).
/// </summary>
public sealed class EventBus : IEventBus, IAsyncDisposable
{
    private readonly IClock clock;
    private readonly IRedactor redactor;
    private readonly ILogger<EventBus> logger;
    private readonly IOptionsMonitor<EventBusOptions> opts;
    private readonly ConcurrentDictionary<Guid, ISubscriptionInternal> subs = new();
    private readonly DedupCache dedup;
    private int disposed;

    /// <summary>Initializes a new instance of the <see cref="EventBus"/> class.</summary>
    /// <param name="clock">The clock used for dedup-window evaluation.</param>
    /// <param name="redactor">The redactor applied to every published event (INV-3).</param>
    /// <param name="logger">Logger for diagnostic output.</param>
    /// <param name="opts">Options monitor for live-reloadable bus configuration.</param>
    public EventBus(
        IClock clock,
        IRedactor redactor,
        ILogger<EventBus> logger,
        IOptionsMonitor<EventBusOptions> opts)
    {
        ArgumentNullException.ThrowIfNull(clock);
        ArgumentNullException.ThrowIfNull(redactor);
        ArgumentNullException.ThrowIfNull(logger);
        ArgumentNullException.ThrowIfNull(opts);

        this.clock = clock;
        this.redactor = redactor;
        this.logger = logger;
        this.opts = opts;
        this.dedup = new DedupCache(clock);
    }

    /// <inheritdoc />
    public async ValueTask PublishAsync<TEvent>(TEvent @event, CancellationToken ct)
        where TEvent : notnull
    {
        ArgumentNullException.ThrowIfNull(@event);
        if (Volatile.Read(ref this.disposed) != 0)
        {
            throw new ObjectDisposedException(nameof(EventBus));
        }

        // INV-3 — apply redactor to all string-valued payload fields before fan-out.
        var redacted = RedactionWalker.Redact(@event, this.redactor);

        // INV-4 / CONC-CHAN-2 — drop duplicates within the dedup window.
        var options = this.opts.CurrentValue;
        if (options.EnableDedup)
        {
            var key = ExtractDedupKey(redacted);
            if (!this.dedup.TryRegister(typeof(TEvent), key, options.DedupWindow))
            {
                return;
            }
        }

        // INV-7 — ConcurrentDictionary enumeration is lock-free (see invariants in EventBus class doc).
        foreach (var kv in this.subs)
        {
            if (kv.Value is not Subscription<TEvent> typed)
            {
                continue;
            }

            // For envelope-typed subscriptions, honour the optional structural predicate.
            if (typed.Filter.Predicate is { } pred
                && redacted is Models.Eventing.EventEnvelope env
                && !pred(env))
            {
                continue;
            }

            await this.WriteWithBackpressureAsync(typed, redacted, ct).ConfigureAwait(false);
        }
    }

    /// <inheritdoc />
    public IAsyncDisposable Subscribe<TEvent>(EventFilter filter, Func<TEvent, CancellationToken, ValueTask> handler)
        where TEvent : notnull
    {
        ArgumentNullException.ThrowIfNull(filter);
        ArgumentNullException.ThrowIfNull(handler);
        if (filter.SubscribingPrincipal is null)
        {
            throw new ArgumentException("EventFilter.SubscribingPrincipal must be set.", nameof(filter));
        }

        if (Volatile.Read(ref this.disposed) != 0)
        {
            throw new ObjectDisposedException(nameof(EventBus));
        }

        var options = this.opts.CurrentValue;
        var fullMode = options.Backpressure switch
        {
            BackpressureMode.Wait => BoundedChannelFullMode.Wait,
            BackpressureMode.DropOldest => BoundedChannelFullMode.DropOldest,
            BackpressureMode.DropNewest => BoundedChannelFullMode.DropWrite,
            BackpressureMode.Throw => BoundedChannelFullMode.Wait,
            _ => BoundedChannelFullMode.Wait,
        };

        var channel = Channel.CreateBounded<TEvent>(new BoundedChannelOptions(options.PerSubscriptionBufferSize)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = fullMode,
            AllowSynchronousContinuations = false,
        });

        // EVT-AUTH-1 — pin the principal at subscribe time.
        var pinned = filter.SubscribingPrincipal;
        var pinnedFilter = filter with { SubscribingPrincipal = pinned };

        var sub = new Subscription<TEvent>(
            pinned,
            pinnedFilter,
            handler,
            channel,
            options.PerSubscriptionBufferSize,
            options.Backpressure,
            this.logger,
            s => this.subs.TryRemove(s.Id, out _));

        if (!this.subs.TryAdd(sub.Id, sub))
        {
            throw new InvalidOperationException("Failed to register subscription.");
        }

        return sub;
    }

    /// <inheritdoc />
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref this.disposed, 1) != 0)
        {
            return;
        }

        var disposeTasks = new List<Task>();
        foreach (var kv in this.subs)
        {
            disposeTasks.Add(kv.Value.DisposeAsync().AsTask());
        }

        if (disposeTasks.Count == 0)
        {
            return;
        }

        // INV-8 — wait up to 5 s for graceful drain.
        var all = Task.WhenAll(disposeTasks);
        var winner = await Task.WhenAny(all, Task.Delay(TimeSpan.FromSeconds(5))).ConfigureAwait(false);
        if (winner != all)
        {
            this.logger.LogWarning(
                "EventBus.DisposeAsync timed out after 5s with {Pending} subscription(s) still draining.",
                disposeTasks.Count);
        }
    }

    private static string? ExtractDedupKey<TEvent>(TEvent @event)
    {
        var prop = @event!.GetType().GetProperty(
            "DedupKey",
            BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
        if (prop is null || prop.PropertyType != typeof(string))
        {
            return null;
        }

        return prop.GetValue(@event) as string;
    }

    private async ValueTask WriteWithBackpressureAsync<TEvent>(
        Subscription<TEvent> sub,
        TEvent item,
        CancellationToken ct)
        where TEvent : notnull
    {
        switch (sub.Mode)
        {
            case BackpressureMode.Wait:
                await sub.Writer.WriteAsync(item, ct).ConfigureAwait(false);
                return;

            case BackpressureMode.DropOldest:
            case BackpressureMode.DropNewest:
                {
                    var wasFull = sub.CurrentDepth >= sub.Capacity;
                    _ = sub.Writer.TryWrite(item);
                    if (wasFull)
                    {
                        this.OnDropped(sub, sub.Mode);
                    }

                    return;
                }

            case BackpressureMode.Throw:
                if (!sub.Writer.TryWrite(item))
                {
                    throw new EventBusFullException(
                        $"Subscription {sub.Id} channel is full (mode=Throw, capacity={sub.Capacity}).");
                }

                return;

            default:
                throw new InvalidOperationException($"Unknown BackpressureMode: {sub.Mode}");
        }
    }

    private void OnDropped<TEvent>(Subscription<TEvent> sub, BackpressureMode mode)
        where TEvent : notnull
    {
        var n = sub.IncrementDropped();
        var lagged = new EventBusSubscriptionLagged(sub.Id, n, mode);
        this.logger.LogWarning(
            "EventBus subscription {SubscriptionId} lagged: dropped={Dropped} mode={Mode}",
            sub.Id,
            n,
            mode);

        // Best-effort fan-out of the lagged event to any subscribers of EventBusSubscriptionLagged.
        foreach (var kv in this.subs)
        {
            if (kv.Value is Subscription<EventBusSubscriptionLagged> sink)
            {
                _ = sink.Writer.TryWrite(lagged);
            }
        }
    }
}
