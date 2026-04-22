// <copyright file="SchedulingChannels.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Threading.Channels;
using AiOrchestrator.Models.Ids;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Plan.Scheduler.Channels;

/// <summary>
/// Provides the bounded channels used by the scheduler (CONC-CHAN-1) and deduplication
/// for schedule events with the same <c>(planId, jobId, eventType)</c> key within a
/// configurable time window (CONC-CHAN-2).
/// </summary>
internal sealed class SchedulingChannels
{
    private readonly Channel<JobId> readyChannel;
    private readonly Channel<JobId> scheduledChannel;
    private readonly ConcurrentDictionary<(string PlanId, string JobId, string EventType), long> dedupCache;
    private readonly SchedulerOptions opts;

    /// <summary>Initializes a new instance of the <see cref="SchedulingChannels"/> class.</summary>
    /// <param name="opts">The scheduler options monitor providing capacity and dedup settings.</param>
    public SchedulingChannels(IOptionsMonitor<SchedulerOptions> opts)
    {
        this.opts = opts.CurrentValue;

        this.readyChannel = Channel.CreateBounded<JobId>(new BoundedChannelOptions(this.opts.ReadyChannelCapacity)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = false,
            SingleWriter = false,
        });

        this.scheduledChannel = Channel.CreateBounded<JobId>(new BoundedChannelOptions(this.opts.ScheduledChannelCapacity)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = false,
            SingleWriter = false,
        });

        this.dedupCache = new ConcurrentDictionary<(string, string, string), long>();
    }

    /// <summary>Gets the bounded ready-job channel. Writers block when the channel is full (CONC-CHAN-1).</summary>
    public Channel<JobId> ReadyChannel => this.readyChannel;

    /// <summary>Gets the bounded scheduled-job channel. Writers block when the channel is full (CONC-CHAN-1).</summary>
    public Channel<JobId> ScheduledChannel => this.scheduledChannel;

    /// <summary>
    /// Checks whether an event with the given key has already been processed within the dedup window (CONC-CHAN-2).
    /// Returns <see langword="true"/> if the event should be processed (not a duplicate or outside the window),
    /// or <see langword="false"/> if it is a duplicate within the window.
    /// </summary>
    /// <param name="planId">The plan identifier.</param>
    /// <param name="jobId">The job identifier.</param>
    /// <param name="eventType">A string label for the event type (e.g. "ready", "scheduled").</param>
    /// <param name="monotonicMs">The current monotonic clock value in milliseconds.</param>
    /// <returns><see langword="true"/> if this event should be processed; <see langword="false"/> if deduped.</returns>
    public bool TryDedup(PlanId planId, JobId jobId, string eventType, long monotonicMs)
    {
        if (!this.opts.EnableEventDedup)
        {
            return true;
        }

        var key = (planId.ToString(), jobId.ToString(), eventType);
        var windowMs = (long)this.opts.DedupWindow.TotalMilliseconds;

        if (this.dedupCache.TryGetValue(key, out var lastMs) && (monotonicMs - lastMs) < windowMs)
        {
            return false;
        }

        this.dedupCache[key] = monotonicMs;
        return true;
    }

    /// <summary>Completes both channels, signalling that no more items will be written.</summary>
    public void Complete()
    {
        _ = this.readyChannel.Writer.TryComplete();
        _ = this.scheduledChannel.Writer.TryComplete();
    }
}
