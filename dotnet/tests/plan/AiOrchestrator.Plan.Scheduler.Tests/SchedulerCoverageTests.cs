// <copyright file="SchedulerCoverageTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.Scheduler.Channels;
using AiOrchestrator.Plan.Scheduler.Events;
using AiOrchestrator.Plan.Scheduler.Race;
using AiOrchestrator.Plan.Scheduler.Ready;
using JobNode = AiOrchestrator.Plan.Models.JobNode;
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

        Assert.Equal(planId, evt.PlanId);
        Assert.Equal(jobId, evt.JobId);
        Assert.Equal(blockerId, evt.BlockedBy);
        Assert.Equal(at, evt.At);
    }

    [Fact]
    public void EventRecords_JobScheduledEvent_Properties()
    {
        var planId = PlanId.New();
        var jobId = JobId.New();
        var at = DateTimeOffset.UtcNow;

        var evt = new JobScheduledEvent { PlanId = planId, JobId = jobId, At = at };

        Assert.Equal(planId, evt.PlanId);
        Assert.Equal(jobId, evt.JobId);
        Assert.Equal(at, evt.At);
    }

    [Fact]
    public void PlanGraph_Jobs_And_AllJobIds_Accessible()
    {
        var jobId = JobId.New();
        var job = new JobNode { Id = jobId.ToString(), Title = "job-a", Status = JobStatus.Pending };
        var plan = new PlanRecord { Id = PlanId.New().ToString(), Jobs = new Dictionary<string, JobNode> { [job.Id] = job } };

        var graph = new PlanGraph(plan);

        Assert.True(graph.Jobs.ContainsKey(job.Id));
        Assert.Contains(job.Id, graph.AllJobIds);
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
        Assert.Contains(jobAId.ToString(), graph.GetPredecessors(jobBId.ToString()));
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

        Assert.Empty(ready);
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

        Assert.False(result.AdjustedPlan.Jobs.ContainsKey(removeId));
        Assert.NotEmpty(result.SvDependencyEdges);
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

        Assert.Empty(result.SvDependencyEdges);
        Assert.True(result.AdjustedPlan.Jobs.ContainsKey(jobId));
    }

    [Fact]
    public void SchedulingChannels_ScheduledChannel_IsAccessible()
    {
        var opts = new SchedulerOptions { ScheduledChannelCapacity = 16, EnableEventDedup = false };
        var channels = new SchedulingChannels(new FixedOptions<SchedulerOptions>(opts));

        Assert.NotNull(channels.ScheduledChannel);
        channels.Complete();
    }
}
