// <copyright file="Subscription.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Threading.Channels;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Models.Auth;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Eventing;

/// <summary>
/// A single typed subscription registered with <see cref="EventBus"/>.
/// Owns one bounded <see cref="Channel{T}"/> and a single background reader task that
/// dispatches buffered events to the user-supplied handler. The reader loop terminates
/// when the writer is completed, satisfying the dispose-drain contract (INV-6).
/// </summary>
/// <typeparam name="TEvent">The event type.</typeparam>
internal sealed class Subscription<TEvent> : ISubscriptionInternal
    where TEvent : notnull
{
    private readonly Channel<TEvent> channel;
    private readonly Func<TEvent, CancellationToken, ValueTask> handler;
    private readonly CancellationTokenSource handlerCts = new();
    private readonly Task readerTask;
    private readonly ILogger logger;
    private readonly Action<Subscription<TEvent>> removeFromBus;
    private int dropped;
    private int disposed;

    /// <summary>Initializes a new instance of the <see cref="Subscription{TEvent}"/> class.</summary>
    /// <param name="principal">The pinned principal at subscribe time (EVT-AUTH-1).</param>
    /// <param name="filter">The subscription filter.</param>
    /// <param name="handler">The user-supplied handler invoked once per delivered event.</param>
    /// <param name="channel">The bounded channel buffering events for this subscription.</param>
    /// <param name="capacity">The configured channel capacity; surfaced for backpressure heuristics.</param>
    /// <param name="mode">The configured backpressure mode.</param>
    /// <param name="logger">Logger for diagnostic output.</param>
    /// <param name="removeFromBus">Callback invoked during dispose to remove the subscription from the bus registry.</param>
    public Subscription(
        AuthContext principal,
        EventFilter filter,
        Func<TEvent, CancellationToken, ValueTask> handler,
        Channel<TEvent> channel,
        int capacity,
        BackpressureMode mode,
        ILogger logger,
        Action<Subscription<TEvent>> removeFromBus)
    {
        this.PrincipalAtSubscribe = principal;
        this.Filter = filter;
        this.Capacity = capacity;
        this.Mode = mode;
        this.handler = handler;
        this.channel = channel;
        this.logger = logger;
        this.removeFromBus = removeFromBus;
        this.Id = Guid.NewGuid();
        this.readerTask = Task.Run(this.RunHandlerLoopAsync);
    }

    /// <inheritdoc />
    public Guid Id { get; }

    /// <summary>Gets the principal pinned at subscribe time (EVT-AUTH-1).</summary>
    public AuthContext PrincipalAtSubscribe { get; }

    /// <summary>Gets the subscription filter (with the principal pinned).</summary>
    public EventFilter Filter { get; }

    /// <summary>Gets the configured per-subscription buffer capacity.</summary>
    public int Capacity { get; }

    /// <summary>Gets the backpressure mode this subscription was created with.</summary>
    public BackpressureMode Mode { get; }

    /// <inheritdoc />
    public Type EventType => typeof(TEvent);

    /// <summary>Gets the cumulative count of dropped events on this subscription.</summary>
    public int DroppedCount => Volatile.Read(ref this.dropped);

    /// <summary>Gets the writer end of the bounded channel.</summary>
    public ChannelWriter<TEvent> Writer => this.channel.Writer;

    /// <summary>Gets the reader end of the bounded channel.</summary>
    public ChannelReader<TEvent> Reader => this.channel.Reader;

    /// <summary>Gets the current depth of the bounded channel.</summary>
    public int CurrentDepth => this.channel.Reader.CanCount ? this.channel.Reader.Count : 0;

    /// <summary>Increments the dropped-events counter and returns the new value.</summary>
    /// <returns>The cumulative drop count after incrementing.</returns>
    public int IncrementDropped() => Interlocked.Increment(ref this.dropped);

    /// <inheritdoc />
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref this.disposed, 1) != 0)
        {
            return;
        }

        // INV-6 — completing the writer lets the reader loop drain and exit naturally.
        _ = this.channel.Writer.TryComplete();

        try
        {
            await this.readerTask.ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Expected on bus tear-down.
        }
        catch (Exception ex)
        {
            this.logger.LogWarning(ex, "Subscription {SubscriptionId} reader loop faulted on dispose.", this.Id);
        }

        this.handlerCts.Dispose();
        this.removeFromBus(this);
    }

    private async Task RunHandlerLoopAsync()
    {
        try
        {
            await foreach (var item in this.channel.Reader.ReadAllAsync(this.handlerCts.Token).ConfigureAwait(false))
            {
                try
                {
                    await this.handler(item, this.handlerCts.Token).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    this.logger.LogError(
                        ex,
                        "Subscription {SubscriptionId} handler threw; continuing to next event.",
                        this.Id);
                }
            }
        }
        catch (OperationCanceledException)
        {
            // graceful shutdown
        }
    }
}
