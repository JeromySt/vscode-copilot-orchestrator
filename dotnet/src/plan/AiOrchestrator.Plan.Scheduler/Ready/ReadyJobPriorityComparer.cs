// <copyright file="ReadyJobPriorityComparer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Models;
using PlanRecord = AiOrchestrator.Plan.Models.Plan;

namespace AiOrchestrator.Plan.Scheduler.Ready;

/// <summary>
/// Compares ready jobs for scheduling priority.
/// Order: retries first → most dependents → alphabetical by title.
/// </summary>
internal sealed class ReadyJobPriorityComparer : IComparer<JobId>
{
    private readonly IReadOnlyDictionary<string, JobNode> jobs;
    private readonly Dictionary<string, int> dependentCounts;

    /// <summary>Initializes a new instance of the <see cref="ReadyJobPriorityComparer"/> class.</summary>
    /// <param name="plan">The plan whose jobs are being prioritized.</param>
    public ReadyJobPriorityComparer(PlanRecord plan)
    {
        this.jobs = plan.Jobs;
        this.dependentCounts = ComputeDependentCounts(plan);
    }

    /// <inheritdoc />
    public int Compare(JobId x, JobId y)
    {
        var xStr = x.ToString();
        var yStr = y.ToString();

        if (!this.jobs.TryGetValue(xStr, out var jobX) ||
            !this.jobs.TryGetValue(yStr, out var jobY))
        {
            return 0;
        }

        // 1. Retries first (jobs with prior attempts).
        var retryX = jobX.Attempts.Count > 0 ? 0 : 1;
        var retryY = jobY.Attempts.Count > 0 ? 0 : 1;
        if (retryX != retryY)
        {
            return retryX.CompareTo(retryY);
        }

        // 2. More dependents first (descending).
        var depsX = this.dependentCounts.GetValueOrDefault(xStr);
        var depsY = this.dependentCounts.GetValueOrDefault(yStr);
        if (depsX != depsY)
        {
            return depsY.CompareTo(depsX);
        }

        // 3. Alphabetical by title.
        return string.Compare(jobX.Title, jobY.Title, StringComparison.Ordinal);
    }

    private static Dictionary<string, int> ComputeDependentCounts(PlanRecord plan)
    {
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var (_, node) in plan.Jobs)
        {
            foreach (var dep in node.DependsOn)
            {
                counts[dep] = counts.GetValueOrDefault(dep) + 1;
            }
        }

        return counts;
    }
}
