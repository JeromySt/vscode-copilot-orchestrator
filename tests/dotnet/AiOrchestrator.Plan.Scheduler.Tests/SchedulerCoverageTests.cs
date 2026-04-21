// <copyright file="SchedulerCoverageTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Scheduler.Channels;
using AiOrchestrator.Plan.Scheduler.Events;
using AiOrchestrator.Plan.Scheduler.Race;
using AiOrchestrator.Plan.Scheduler.Ready;
using FluentAssertions;
using JobNode = AiOrchestrator.Plan.Models.JobNode;
using JobStatus = AiOrchestrator.Plan.Models.JobStatus;
using PlanRecord = AiOrchestrator.Plan.Models.Plan;
using Xunit;

namespace AiOrchestrator.Plan.Scheduler.Tests;

/// <summary>Additional tests targeting coverage gaps in Plan.Scheduler source files.</summary>
public sealed class SchedulerCoverageTests
{
    [Fact]
    public void EventRecords_JobBlockedEvent_Properties()
    {
        var planId = PlanId.New();
        var jobId = JobId.New();
        var blockerId = JobId.New();
        var at = DateTimeOffset.UtcNow;

        var evt = new JobBlockedEvent { PlanId = planId, JobId = jobId, BlockedBy = blockerId, At = at };

        evt.PlanId.Should().Be(planId);
        evt.JobId.Should().Be(jobId);
        evt.BlockedBy.Should().Be(blockerId);
        evt.At.Should().Be(at);
    }

    [Fact]
    public void EventRecords_JobScheduledEvent_Properties()
    {
        var planId = PlanId.New();
        var jobId = JobId.New();
        var at = DateTimeOffset.UtcNow;

        var evt = new JobScheduledEvent { PlanId = planId, JobId = jobId, At = at };

        evt.PlanId.Should().Be(planId);
        evt.JobId.Should().Be(jobId);
        evt.At.Should().Be(at);
    }

    [Fact]
    public void PlanGraph_Jobs_And_AllJobIds_Accessible()
    {
        var jobId = JobId.New();
        var job = new JobNode { Id = jobId.ToString(), Title = "job-a", Status = JobStatus.Pending };
        var plan = new PlanRecord { Id = PlanId.New().ToString(), Jobs = new Dictionary<string, JobNode> { [job.Id] = job } };

        var graph = new PlanGraph(plan);

        graph.Jobs.Should().ContainKey(job.Id);
        graph.AllJobIds.Should().Contain(job.Id);
    }

    [Fact]
    public void PlanGraph_WithDependsOn_BuildsSuccessorIndex()
    {
        var jobAId = JobId.New();
        var jobBId = JobId.New();

        var jobA = new JobNode { Id = jobAId.ToString(), Title = "job-a", Status = JobStatus.Pending };
        var jobB = new JobNode
        {
            Id = jobBId.ToString(),
            Title = "job-b",
            Status = JobStatus.Pending,
            DependsOn = [jobAId.ToString()],
        };

        var plan = new PlanRecord
        {
            Id = PlanId.New().ToString(),
            Jobs = new Dictionary<string, JobNode> { [jobA.Id] = jobA, [jobB.Id] = jobB },
        };

        var graph = new PlanGraph(plan);

        // GetPredecessors should return jobA as a predecessor of jobB.
        graph.GetPredecessors(jobBId.ToString()).Should().Contain(jobAId.ToString());
    }

    [Fact]
    public void ReadySet_PredecessorNotInStatusMap_TreatsAsNotSucceeded()
    {
        var jobAId = JobId.New();
        var missingPredId = JobId.New();

        // jobA depends on missingPred, but missingPred won't be in the status map.
        var jobA = new JobNode
        {
            Id = jobAId.ToString(),
            Title = "job-a",
            Status = JobStatus.Pending,
            DependsOn = [missingPredId.ToString()],
        };

        var plan = new PlanRecord
        {
            Id = PlanId.New().ToString(),
            Jobs = new Dictionary<string, JobNode> { [jobA.Id] = jobA },
        };

        var graph = new PlanGraph(plan);
        var readySet = new ReadySet(graph);

        var statuses = new Dictionary<JobId, JobStatus> { [jobAId] = JobStatus.Pending };
        var ready = readySet.ComputeReady(statuses);

        ready.Should().BeEmpty("job A's predecessor is absent from the status map so it cannot be Succeeded");
    }

    [Fact]
    public void T22T14Resolver_RemoveJob_DropsJobFromAdjustedPlan()
    {
        var svId = JobId.New().ToString();
        var leafId = JobId.New().ToString();
        var removeId = JobId.New().ToString();

        // SV starts with empty DependsOn — the resolver will compute and wire the edges.
        var svNode = new JobNode { Id = svId, Title = "snapshot-validation", Status = JobStatus.Pending, DependsOn = [] };
        var leafNode = new JobNode { Id = leafId, Title = "leaf", Status = JobStatus.Pending };
        var removeNode = new JobNode { Id = removeId, Title = "to-remove", Status = JobStatus.Pending };

        var plan = new PlanRecord
        {
            Id = PlanId.New().ToString(),
            Jobs = new Dictionary<string, JobNode>
            {
                [svId] = svNode,
                [leafId] = leafNode,
                [removeId] = removeNode,
            },
        };

        var resolver = new T22T14Resolver();
        var pending = ImmutableArray.Create(new ReshapeOperation { Kind = ReshapeKind.RemoveJob, Job = removeNode });

        var result = resolver.Resolve(plan, pending);

        result.AdjustedPlan.Jobs.Should().NotContainKey(removeId, "RemoveJob must drop the job from the adjusted plan");
        result.SvDependencyEdges.Should().NotBeEmpty("after removing the extra node the leaf remains and SV must wire to it");
    }

    [Fact]
    public void T22T14Resolver_NoSvNode_ReturnsEmptyEdges()
    {
        var jobId = JobId.New().ToString();
        var job = new JobNode { Id = jobId, Title = "leaf-without-sv", Status = JobStatus.Pending };

        var plan = new PlanRecord
        {
            Id = PlanId.New().ToString(),
            Jobs = new Dictionary<string, JobNode> { [jobId] = job },
        };

        var resolver = new T22T14Resolver();
        var result = resolver.Resolve(plan, ImmutableArray<ReshapeOperation>.Empty);

        result.SvDependencyEdges.Should().BeEmpty("no SV node means no edges to produce");
        result.AdjustedPlan.Jobs.Should().ContainKey(jobId, "job must remain in the adjusted plan");
    }

    [Fact]
    public void SchedulingChannels_ScheduledChannel_IsAccessible()
    {
        var opts = new SchedulerOptions { ScheduledChannelCapacity = 16, EnableEventDedup = false };
        var channels = new SchedulingChannels(new FixedOptions<SchedulerOptions>(opts));

        channels.ScheduledChannel.Should().NotBeNull("ScheduledChannel must be initialized");
        channels.Complete();
    }
}
