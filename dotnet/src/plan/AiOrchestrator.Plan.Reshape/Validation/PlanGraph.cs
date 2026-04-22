// <copyright file="PlanGraph.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using AiOrchestrator.Plan.Models;

namespace AiOrchestrator.Plan.Reshape.Validation;

/// <summary>
/// In-memory immutable view over a plan's DAG used by <see cref="CycleGuard"/> and batch projection.
/// Keyed by string job ids (matching <see cref="JobNode.Id"/>).
/// </summary>
internal sealed record PlanGraph
{
    /// <summary>Gets the jobs keyed by their <see cref="JobNode.Id"/>.</summary>
    public required ImmutableDictionary<string, JobNode> Jobs { get; init; }

    /// <summary>Creates a graph snapshot from a live <see cref="AiOrchestrator.Plan.Models.Plan"/>.</summary>
    /// <param name="plan">The plan to snapshot.</param>
    /// <returns>An immutable graph.</returns>
    public static PlanGraph From(AiOrchestrator.Plan.Models.Plan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        return new PlanGraph { Jobs = plan.Jobs.ToImmutableDictionary(StringComparer.Ordinal) };
    }

    /// <summary>Returns the IDs of every job whose <c>DependsOn</c> includes <paramref name="jobId"/>.</summary>
    /// <param name="jobId">The upstream job id.</param>
    /// <returns>The successor ids.</returns>
    public IEnumerable<string> SuccessorsOf(string jobId)
    {
        foreach (var (id, node) in this.Jobs)
        {
            for (int i = 0; i < node.DependsOn.Count; i++)
            {
                if (string.Equals(node.DependsOn[i], jobId, StringComparison.Ordinal))
                {
                    yield return id;
                    break;
                }
            }
        }
    }

    /// <summary>Creates a new graph with a job added or replaced.</summary>
    /// <param name="node">The node to set.</param>
    /// <returns>A new <see cref="PlanGraph"/>.</returns>
    public PlanGraph WithJob(JobNode node)
    {
        ArgumentNullException.ThrowIfNull(node);
        return new PlanGraph { Jobs = this.Jobs.SetItem(node.Id, node) };
    }

    /// <summary>Creates a new graph with a job removed (plus cleanup of references to it).</summary>
    /// <param name="jobId">The id to remove.</param>
    /// <returns>A new <see cref="PlanGraph"/>.</returns>
    public PlanGraph WithoutJob(string jobId)
    {
        ArgumentNullException.ThrowIfNull(jobId);
        var builder = this.Jobs.ToBuilder();
        _ = builder.Remove(jobId);
        foreach (var (id, node) in this.Jobs)
        {
            if (id == jobId)
            {
                continue;
            }

            if (node.DependsOn.Contains(jobId, StringComparer.Ordinal))
            {
                var filtered = node.DependsOn.Where(d => !string.Equals(d, jobId, StringComparison.Ordinal)).ToArray();
                builder[id] = node with { DependsOn = filtered };
            }
        }

        return new PlanGraph { Jobs = builder.ToImmutable() };
    }

    /// <summary>Returns the count of jobs with no dependencies ("parallel-ready" roots).</summary>
    /// <returns>The number of source nodes.</returns>
    public int CountParallelRoots()
    {
        int n = 0;
        foreach (var (_, node) in this.Jobs)
        {
            if (node.DependsOn.Count == 0)
            {
                n++;
            }
        }

        return n;
    }
}
