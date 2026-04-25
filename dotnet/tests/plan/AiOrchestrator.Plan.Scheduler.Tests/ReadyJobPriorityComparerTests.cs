// <copyright file="ReadyJobPriorityComparerTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.Scheduler.Ready;
using PlanRecord = AiOrchestrator.Plan.Models.Plan;
using JobNode = AiOrchestrator.Plan.Models.JobNode;
using Xunit;

namespace AiOrchestrator.Plan.Scheduler.Tests;

/// <summary>Unit tests for <see cref="ReadyJobPriorityComparer"/>.</summary>
public sealed class ReadyJobPriorityComparerTests
{
    private static PlanRecord MakePlan(params JobNode[] jobs)
    {
        var map = new Dictionary<string, JobNode>();
        foreach (var j in jobs)
        {
            map[j.Id] = j;
        }

        return new PlanRecord { Id = PlanId.New().ToString(), Jobs = map };
    }

    [Fact]
    public void RetriesAreScheduledBeforeFirstAttempts()
    {
        var retryId = JobId.New();
        var freshId = JobId.New();

        var retryJob = new JobNode
        {
            Id = retryId.ToString(),
            Title = "retry-job",
            Status = JobStatus.Ready,
            Attempts = new List<JobAttempt> { new() },
        };
        var freshJob = new JobNode
        {
            Id = freshId.ToString(),
            Title = "fresh-job",
            Status = JobStatus.Ready,
        };

        var plan = MakePlan(retryJob, freshJob);
        var comparer = new ReadyJobPriorityComparer(plan);

        // Retry job should sort before fresh job (negative result).
        Assert.True(comparer.Compare(retryId, freshId) < 0);
        Assert.True(comparer.Compare(freshId, retryId) > 0);
    }

    [Fact]
    public void JobsWithMoreDependentsScheduledFirst()
    {
        var rootId = JobId.New();
        var leafAId = JobId.New();
        var leafBId = JobId.New();

        // root has 2 dependents (leafA and leafB both depend on root)
        var root = new JobNode { Id = rootId.ToString(), Title = "root", Status = JobStatus.Pending };
        var leafA = new JobNode
        {
            Id = leafAId.ToString(),
            Title = "leaf-a",
            Status = JobStatus.Pending,
            DependsOn = new List<string> { rootId.ToString() },
        };
        var leafB = new JobNode
        {
            Id = leafBId.ToString(),
            Title = "leaf-b",
            Status = JobStatus.Pending,
            DependsOn = new List<string> { rootId.ToString() },
        };

        var plan = MakePlan(root, leafA, leafB);
        var comparer = new ReadyJobPriorityComparer(plan);

        // root has 2 dependents, leafA has 0 → root should come first.
        Assert.True(comparer.Compare(rootId, leafAId) < 0);
    }

    [Fact]
    public void TiebreakIsAlphabeticalByTitle()
    {
        var alphaId = JobId.New();
        var betaId = JobId.New();

        var alpha = new JobNode { Id = alphaId.ToString(), Title = "alpha", Status = JobStatus.Pending };
        var beta = new JobNode { Id = betaId.ToString(), Title = "beta", Status = JobStatus.Pending };

        var plan = MakePlan(alpha, beta);
        var comparer = new ReadyJobPriorityComparer(plan);

        Assert.True(comparer.Compare(alphaId, betaId) < 0);
        Assert.True(comparer.Compare(betaId, alphaId) > 0);
    }

    [Fact]
    public void SameJob_ReturnsZero()
    {
        var id = JobId.New();
        var job = new JobNode { Id = id.ToString(), Title = "solo", Status = JobStatus.Pending };
        var plan = MakePlan(job);
        var comparer = new ReadyJobPriorityComparer(plan);

        Assert.Equal(0, comparer.Compare(id, id));
    }

    [Fact]
    public void UnknownJobId_ReturnsZero()
    {
        var knownId = JobId.New();
        var unknownId = JobId.New();
        var job = new JobNode { Id = knownId.ToString(), Title = "known", Status = JobStatus.Pending };
        var plan = MakePlan(job);
        var comparer = new ReadyJobPriorityComparer(plan);

        Assert.Equal(0, comparer.Compare(knownId, unknownId));
        Assert.Equal(0, comparer.Compare(unknownId, knownId));
    }

    [Fact]
    public void SortedList_UsesComparerCorrectly()
    {
        var retryId = JobId.New();
        var highFanId = JobId.New();
        var alphaId = JobId.New();

        var leafId = JobId.New();

        var retry = new JobNode
        {
            Id = retryId.ToString(),
            Title = "zzz-retry",
            Status = JobStatus.Ready,
            Attempts = new List<JobAttempt> { new() },
        };
        var highFan = new JobNode
        {
            Id = highFanId.ToString(),
            Title = "mid-fan",
            Status = JobStatus.Pending,
        };
        var alpha = new JobNode
        {
            Id = alphaId.ToString(),
            Title = "aaa-alpha",
            Status = JobStatus.Pending,
        };
        var leaf = new JobNode
        {
            Id = leafId.ToString(),
            Title = "leaf",
            Status = JobStatus.Pending,
            DependsOn = new List<string> { highFanId.ToString() },
        };

        var plan = MakePlan(retry, highFan, alpha, leaf);
        var comparer = new ReadyJobPriorityComparer(plan);

        var list = new List<JobId> { alphaId, highFanId, retryId };
        list.Sort(comparer);

        // retry first (has attempts), then highFan (1 dependent > 0), then alpha (alphabetical)
        Assert.Equal(retryId, list[0]);
        Assert.Equal(highFanId, list[1]);
        Assert.Equal(alphaId, list[2]);
    }
}
