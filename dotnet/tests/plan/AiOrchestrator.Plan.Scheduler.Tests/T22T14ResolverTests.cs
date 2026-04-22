// Assert.Equivalent(new[] { leaf1.Id, leaf2.Id }, <copyright file="T22T14ResolverTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Scheduler.Race;
using JobNode = AiOrchestrator.Plan.Models.JobNode;
using JobStatus = AiOrchestrator.Plan.Models.JobStatus;
using PlanRecord = AiOrchestrator.Plan.Models.Plan;
using Xunit;

namespace AiOrchestrator.Plan.Scheduler.Tests;

/// <summary>Acceptance tests for T22/T14 race-rule resolution (SV node dependency re-injection).</summary>
public sealed class T22T14ResolverTests
{
    private static PlanRecord MakePlanWithSv(out string svId, params JobNode[] extraJobs)
    {
        var svJobId = JobId.New().ToString();
        svId = svJobId;

        var svNode = new JobNode { Id = svJobId, Title = "snapshot-validation", Status = JobStatus.Pending };
        var jobs = new Dictionary<string, JobNode> { [svNode.Id] = svNode };

        foreach (var job in extraJobs)
        {
            jobs[job.Id] = job;
        }

        return new PlanRecord { Id = PlanId.New().ToString(), Jobs = jobs };
    }

    [Fact]
    [ContractTest("T22-RULE")]
    public void T22_RULE_SvInjectionAfterLeavesReady()
    {
        var leaf1 = new JobNode { Id = JobId.New().ToString(), Title = "leaf-1", Status = JobStatus.Pending };
        var leaf2 = new JobNode { Id = JobId.New().ToString(), Title = "leaf-2", Status = JobStatus.Pending };

        var plan = MakePlanWithSv(out var svId, leaf1, leaf2);
        var resolver = new T22T14Resolver();

        var result = resolver.Resolve(plan, ImmutableArray<ReshapeOperation>.Empty);

        var svNode = result.AdjustedPlan.Jobs[svId];
        Assert.Contains(leaf1.Id, svNode.DependsOn);
        Assert.Contains(leaf2.Id, svNode.DependsOn);

        Assert.Equal(2, result.SvDependencyEdges.Count());
        Assert.True(result.SvDependencyEdges.All(e => e.To == JobId.Parse(svId)), "all edges point to SV");
    }

    [Fact]
    [ContractTest("T14-RULE")]
    public void T14_RULE_ReshapeReinjectsSvDeps()
    {
        var existingLeaf = new JobNode { Id = JobId.New().ToString(), Title = "existing-leaf", Status = JobStatus.Pending };
        var plan = MakePlanWithSv(out var svId, existingLeaf);

        var addedJob = new JobNode { Id = JobId.New().ToString(), Title = "new-job", Status = JobStatus.Pending };
        var pending = ImmutableArray.Create(new ReshapeOperation { Kind = ReshapeKind.AddJob, Job = addedJob });

        var resolver = new T22T14Resolver();
        var result = resolver.Resolve(plan, pending);

        var svNode = result.AdjustedPlan.Jobs[svId];
        Assert.Contains(addedJob.Id, svNode.DependsOn);

        Assert.Equal(2, result.SvDependencyEdges.Count());
    }

    [Fact]
    [ContractTest("T22-T14-FUZZ")]
    public void T22_T14_FUZZ_RandomReshapeNeverLosesSv()
    {
        var rng = new Random(12345);
        var resolver = new T22T14Resolver();

        for (int i = 0; i < 10_000; i++)
        {
            // Build a plan with 1 SV node plus 1–4 initial leaf jobs.
            int leafCount = rng.Next(1, 5);
            var leaves = Enumerable.Range(0, leafCount)
                .Select(_ => new JobNode
                {
                    Id = JobId.New().ToString(),
                    Title = "leaf-" + rng.Next(1000),
                    Status = JobStatus.Pending,
                })
                .ToArray();

            var plan = MakePlanWithSv(out var svId, leaves);

            // 0–3 pending AddJob reshape operations (each adds a new leaf with no dependencies).
            int reshapeCount = rng.Next(0, 4);
            var pending = Enumerable.Range(0, reshapeCount)
                .Select(_ => new ReshapeOperation
                {
                    Kind = ReshapeKind.AddJob,
                    Job = new JobNode
                    {
                        Id = JobId.New().ToString(),
                        Title = "extra-" + rng.Next(1000),
                        Status = JobStatus.Pending,
                    },
                })
                .ToImmutableArray();

            var result = resolver.Resolve(plan, pending);

            // All non-SV jobs in the adjusted plan are leaves (no successors → no jobs depend on them).
            var expectedLeafIds = result.AdjustedPlan.Jobs.Keys
                .Where(id => id != svId)
                .OrderBy(id => id)
                .ToList();

            var svDeps = result.AdjustedPlan.Jobs[svId].DependsOn
                .OrderBy(id => id)
                .ToList();

            Assert.Equal(expectedLeafIds, svDeps);
        }
    }
}
