// <copyright file="ReadySetTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Scheduler.Ready;
using FluentAssertions;
using PlanRecord = AiOrchestrator.Plan.Models.Plan;
using JobNode = AiOrchestrator.Plan.Models.JobNode;
using JobStatus = AiOrchestrator.Plan.Models.JobStatus;
using Xunit;

namespace AiOrchestrator.Plan.Scheduler.Tests;

/// <summary>Acceptance tests for ready-set computation (INV-1, INV-2).</summary>
public sealed class ReadySetTests
{
    [Fact]
    [ContractTest("SCHED-RDY-1")]
    public void SCHED_RDY_1_OnlyPendingWithSucceededPredsBecomeReady()
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
        var readySet = new ReadySet(graph);

        var statuses = new Dictionary<JobId, JobStatus>
        {
            [jobAId] = JobStatus.Pending,
            [jobBId] = JobStatus.Pending,
        };

        var ready = readySet.ComputeReady(statuses);

        ready.Should().ContainSingle()
            .Which.Should().Be(jobAId, "only A has all predecessors met (none); B's predecessor A is not Succeeded");
    }

    [Fact]
    [ContractTest("SCHED-RDY-2")]
    public void SCHED_RDY_2_BlockedJobNeverReady()
    {
        var jobAId = JobId.New();
        var jobBId = JobId.New();

        var jobA = new JobNode { Id = jobAId.ToString(), Title = "job-a", Status = JobStatus.Failed };
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
        var readySet = new ReadySet(graph);

        var statuses = new Dictionary<JobId, JobStatus>
        {
            [jobAId] = JobStatus.Failed,
            [jobBId] = JobStatus.Pending,
        };

        var ready = readySet.ComputeReady(statuses);

        ready.Should().BeEmpty("B depends on Failed A and is permanently blocked per INV-2");
    }
}
