// <copyright file="T22T14Resolver.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.Scheduler.Ready;
using PlanRecord = AiOrchestrator.Plan.Models.Plan;

namespace AiOrchestrator.Plan.Scheduler.Race;

/// <summary>
/// Resolves T22/T14 race rules: keeps the snapshot-validation (SV) node's dependency list
/// synchronised with the current set of DAG leaf jobs (§3.31.4.2).
/// <para>
/// <b>T22-RULE</b>: SV injection occurs after all leaf jobs become ready, before any commit phase
/// completes. The resolver recomputes SV.DependsOn whenever called.
/// </para>
/// <para>
/// <b>T14-RULE</b>: A reshape that adds a new leaf forces re-injection: old SV depends-on edges
/// are atomically replaced with the new leaf set.
/// </para>
/// </summary>
internal sealed class T22T14Resolver
{
    /// <summary>
    /// Applies any pending reshape operations to the plan, then re-wires the SV node's
    /// dependencies to the resulting set of leaf nodes.
    /// </summary>
    /// <param name="plan">The current plan snapshot.</param>
    /// <param name="pending">Reshape operations (add/remove jobs) not yet persisted.</param>
    /// <returns>
    /// A <see cref="ResolutionResult"/> containing the adjusted plan with updated SV edges,
    /// and the individual <see cref="JobEdge"/> records representing the leaf→SV wiring.
    /// </returns>
    public ResolutionResult Resolve(PlanRecord plan, ImmutableArray<ReshapeOperation> pending)
    {
        var adjustedJobs = new Dictionary<string, JobNode>(plan.Jobs);

        foreach (var op in pending)
        {
            switch (op.Kind)
            {
                case ReshapeKind.AddJob:
                    adjustedJobs[op.Job.Id] = op.Job;
                    break;

                case ReshapeKind.RemoveJob:
                    _ = adjustedJobs.Remove(op.Job.Id);
                    break;
            }
        }

        var virtualPlan = plan with { Jobs = adjustedJobs };
        var graph = new PlanGraph(virtualPlan);

        var svId = graph.GetSvJobId();
        var leaves = graph.GetLeafJobIds();

        if (svId is null || leaves.IsEmpty)
        {
            return new ResolutionResult
            {
                AdjustedPlan = virtualPlan,
                SvDependencyEdges = ImmutableArray<JobEdge>.Empty,
            };
        }

        var newDeps = leaves.ToImmutableArray();
        var svJobIdStruct = JobId.Parse(svId);
        var edges = newDeps.Select(leafStr => new JobEdge
        {
            From = JobId.Parse(leafStr),
            To = svJobIdStruct,
        }).ToImmutableArray();

        var updatedSvNode = adjustedJobs[svId] with
        {
            DependsOn = newDeps,
        };

        adjustedJobs[svId] = updatedSvNode;

        var finalPlan = virtualPlan with { Jobs = adjustedJobs };

        return new ResolutionResult
        {
            AdjustedPlan = finalPlan,
            SvDependencyEdges = edges,
        };
    }
}
