// <copyright file="SvNodeBuilder.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using AiOrchestrator.Plan.Models;

namespace AiOrchestrator.Plan.Scheduler;

/// <summary>
/// Builds and manages the Snapshot Validation (SV) node that depends on all leaf
/// nodes in the DAG. The SV node runs a premium-tier agent to verify all job
/// outputs satisfy the plan's acceptance criteria.
/// </summary>
public static class SvNodeBuilder
{
    /// <summary>The well-known title prefix for the SV node.</summary>
    public const string SvTitlePrefix = "__snapshot-validation__";

    /// <summary>
    /// Creates a new SV <see cref="JobNode"/> that depends on the given leaf job IDs.
    /// </summary>
    /// <param name="leafJobIds">The IDs of all current leaf jobs in the DAG.</param>
    /// <param name="verifyInstructions">Optional custom verification instructions for the SV agent.</param>
    /// <returns>A new <see cref="JobNode"/> configured as the snapshot-validation node.</returns>
    public static JobNode Build(IEnumerable<string> leafJobIds, string? verifyInstructions = null)
    {
        ArgumentNullException.ThrowIfNull(leafJobIds);

        return new JobNode
        {
            Id = $"sv-{Guid.NewGuid():N}",
            Title = SvTitlePrefix,
            Status = JobStatus.Pending,
            DependsOn = new List<string>(leafJobIds),
            WorkSpec = new WorkSpec
            {
                Instructions = verifyInstructions
                    ?? "Review all committed changes across all jobs. Verify consistency, no regressions, and alignment with the plan description.",
                AllowedFolders = [],
                AllowedUrls = [],
                CheckCommands = [],
            },
            Attempts = [],
            Transitions = [],
        };
    }

    /// <summary>
    /// Returns the ID of the SV node in a plan, or <see langword="null"/> if not present.
    /// </summary>
    /// <param name="plan">The plan to search.</param>
    /// <returns>The SV node's ID, or <see langword="null"/>.</returns>
    public static string? FindSvNodeId(Plan.Models.Plan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);

        foreach (var (id, node) in plan.Jobs)
        {
            if (node.Title.StartsWith(SvTitlePrefix, StringComparison.Ordinal))
            {
                return id;
            }
        }

        return null;
    }

    /// <summary>
    /// Computes the current leaf job IDs (jobs with no successors, excluding the SV node).
    /// </summary>
    /// <param name="plan">The plan to analyze.</param>
    /// <returns>An array of leaf job IDs.</returns>
    public static IReadOnlyList<string> ComputeLeafJobIds(Plan.Models.Plan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);

        var svId = FindSvNodeId(plan);
        var hasSuccessor = new HashSet<string>(StringComparer.Ordinal);

        foreach (var (nodeId, node) in plan.Jobs)
        {
            // Skip SV's own edges — its dependencies are the leaves we want to find.
            if (nodeId == svId)
            {
                continue;
            }

            foreach (var dep in node.DependsOn)
            {
                hasSuccessor.Add(dep);
            }
        }

        var leaves = new List<string>();
        foreach (var (id, _) in plan.Jobs)
        {
            if (id != svId && !hasSuccessor.Contains(id))
            {
                leaves.Add(id);
            }
        }

        return leaves;
    }

    /// <summary>
    /// Recomputes the SV node's <see cref="JobNode.DependsOn"/> to match the current leaf set.
    /// Returns <see langword="null"/> if the plan has no SV node or leaves haven't changed.
    /// </summary>
    /// <param name="plan">The plan to sync.</param>
    /// <returns>The updated leaf set, or <see langword="null"/> if no change is needed.</returns>
    public static IReadOnlyList<string>? SyncDependencies(Plan.Models.Plan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);

        var svId = FindSvNodeId(plan);
        if (svId is null)
        {
            return null;
        }

        var svNode = plan.Jobs[svId];
        var currentLeaves = ComputeLeafJobIds(plan);

        // Compare as sets — order doesn't matter for dependency semantics.
        var existing = new HashSet<string>(svNode.DependsOn, StringComparer.Ordinal);
        var updated = new HashSet<string>(currentLeaves, StringComparer.Ordinal);

        if (existing.SetEquals(updated))
        {
            return null;
        }

        return currentLeaves;
    }
}
