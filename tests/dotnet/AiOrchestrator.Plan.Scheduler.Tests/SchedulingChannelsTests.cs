// <copyright file="SchedulingChannelsTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Scheduler.Channels;
using FluentAssertions;
using Xunit;

namespace AiOrchestrator.Plan.Scheduler.Tests;

/// <summary>Acceptance tests for bounded scheduling channels (CONC-CHAN-1) and event deduplication (CONC-CHAN-2).</summary>
public sealed class SchedulingChannelsTests
{
    [Fact]
    [ContractTest("CONC-CHAN-1")]
    public async Task CONC_CHAN_1_BoundedAtCapacity()
    {
        var opts = new SchedulerOptions
        {
            ReadyChannelCapacity = 1,
            ScheduledChannelCapacity = 16,
            EnableEventDedup = false,
        };

        var channels = new SchedulingChannels(new FixedOptions<SchedulerOptions>(opts));
        using var cts = new CancellationTokenSource();

        var job1 = JobId.New();
        var job2 = JobId.New();

        // First write succeeds (channel has capacity 1).
        await channels.ReadyChannel.Writer.WriteAsync(job1, cts.Token);

        // Second write blocks because the channel is full.
        var secondWrite = channels.ReadyChannel.Writer.WriteAsync(job2, cts.Token).AsTask();
        await Task.Delay(TimeSpan.FromMilliseconds(50), CancellationToken.None);
        secondWrite.IsCompleted.Should().BeFalse("channel is at capacity; second write must block (CONC-CHAN-1)");

        // Drain the channel; second write should now complete.
        var _ = await channels.ReadyChannel.Reader.ReadAsync(cts.Token);
        await secondWrite;
        secondWrite.IsCompletedSuccessfully.Should().BeTrue("second write completes after the channel is drained");
        channels.Complete();
    }

    [Fact]
    [ContractTest("CONC-CHAN-2")]
    public void CONC_CHAN_2_DedupesEventKeyInWindow()
    {
        var opts = new SchedulerOptions
        {
            EnableEventDedup = true,
            DedupWindow = TimeSpan.FromSeconds(1),
        };

        var channels = new SchedulingChannels(new FixedOptions<SchedulerOptions>(opts));

        var planId = PlanId.New();
        var jobId = JobId.New();
        const string EventType = "ready";

        // First occurrence at ms=1000: not a duplicate.
        channels.TryDedup(planId, jobId, EventType, 1000).Should().BeTrue("first event is never a duplicate");

        // Same key at ms=1001: within 1-second window → duplicate.
        channels.TryDedup(planId, jobId, EventType, 1001).Should().BeFalse("same key within dedup window must be suppressed (CONC-CHAN-2)");

        // Same key at ms=2001: outside window → not a duplicate.
        channels.TryDedup(planId, jobId, EventType, 2001).Should().BeTrue("same key outside dedup window must pass through");

        // Different event type: never a duplicate for the same key.
        channels.TryDedup(planId, jobId, "scheduled", 1001).Should().BeTrue("different eventType is a distinct key");
        channels.Complete();
    }
}
