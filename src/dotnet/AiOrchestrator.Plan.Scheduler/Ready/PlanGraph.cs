// <copyright file="PlanGraph.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using AiOrchestrator.Plan.Models;
using PlanRecord = AiOrchestrator.Plan.Models.Plan;

namespace AiOrchestrator.Plan.Scheduler.Ready;

/// <summary>
/// Wraps a plan's job dictionary to provide DAG traversal utilities.
/// All identifiers are string-valued (matching <c>Plan.Jobs</c> keys).
/// </summary>
internal sealed class PlanGraph
{
    private const string SvTitlePrefix = "snapshot-validation";

    private readonly IReadOnlyDictionary<string, JobNode> jobs;
    private readonly Dictionary<string, List<string>> successors;

    /// <summary>Initializes a new instance of the <see cref="PlanGraph"/> class from a plan snapshot.</summary>
    /// <param name="plan">The plan whose jobs form this graph.</param>
    public PlanGraph(PlanRecord plan)
    {
        this.jobs = plan.Jobs;
        this.successors = new Dictionary<string, List<string>>();

        foreach (var (id, node) in this.jobs)
        {
            if (!this.successors.ContainsKey(id))
            {
                this.successors[id] = new List<string>();
            }

            foreach (var dep in node.DependsOn)
            {
                if (!this.successors.TryGetValue(dep, out var s))
                {
                    this.successors[dep] = s = new List<string>();
                }

                s.Add(id);
            }
        }
    }

    /// <summary>Gets the underlying jobs dictionary.</summary>
    public IReadOnlyDictionary<string, JobNode> Jobs => this.jobs;

    /// <summary>Gets all job IDs in the graph.</summary>
    public ImmutableArray<string> AllJobIds => this.jobs.Keys.ToImmutableArray();

    /// <summary>Returns the dependency IDs of the given job.</summary>
    /// <param name="jobId">The string-valued job identifier.</param>
    /// <returns>The IDs of all jobs that must complete before this one.</returns>
    public ImmutableArray<string> GetPredecessors(string jobId) =>
        this.jobs.TryGetValue(jobId, out var node)
            ? node.DependsOn.ToImmutableArray()
            : ImmutableArray<string>.Empty;

    /// <summary>Returns IDs of leaf jobs — jobs that are not a dependency of any other job, excluding the SV node.</summary>
    /// <returns>The leaf job IDs.</returns>
    public ImmutableArray<string> GetLeafJobIds()
    {
        var svId = this.GetSvJobId();
        return this.jobs.Keys
            .Where(id => id != svId && (!this.successors.TryGetValue(id, out var s) || s.Count == 0))
            .ToImmutableArray();
    }

    /// <summary>Returns the identifier of the snapshot-validation (SV) job, or <see langword="null"/> if none exists.</summary>
    /// <returns>The SV job ID string, or <see langword="null"/>.</returns>
    public string? GetSvJobId() =>
        this.jobs.Values
            .FirstOrDefault(n => n.Title.StartsWith(SvTitlePrefix, System.StringComparison.OrdinalIgnoreCase))
            ?.Id;
}
