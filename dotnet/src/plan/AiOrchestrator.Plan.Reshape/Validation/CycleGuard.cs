// <copyright file="CycleGuard.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Models;

namespace AiOrchestrator.Plan.Reshape.Validation;

/// <summary>
/// Pure-function cycle detector over <see cref="PlanGraph"/>. Used by <see cref="PlanReshaper"/>
/// to reject operations that would introduce a cycle (RS-AFTER-2 and general integrity).
/// Does no I/O.
/// </summary>
internal sealed class CycleGuard
{
    /// <summary>
    /// Returns whether applying <paramref name="op"/> to <paramref name="current"/> would create a directed
    /// cycle, and if so, one witness cycle as job ids.
    /// </summary>
    /// <param name="current">The current DAG snapshot.</param>
    /// <param name="op">The operation to test (not applied).</param>
    /// <returns>Cycle diagnostic.</returns>
    public CycleResult WouldCreateCycle(PlanGraph current, ReshapeOperation op)
    {
        ArgumentNullException.ThrowIfNull(current);
        ArgumentNullException.ThrowIfNull(op);

        var projected = Project(current, op);
        var witness = FindCycle(projected);
        if (witness is null)
        {
            return new CycleResult { Cycle = false, Cycle_ = null };
        }

        var ids = witness.Select(TryToJobId).Where(id => id.HasValue).Select(id => id!.Value).ToImmutableArray();
        return new CycleResult { Cycle = true, Cycle_ = ids };
    }

    /// <summary>Applies an operation to a graph returning the projected result.</summary>
    /// <param name="current">The current graph.</param>
    /// <param name="op">The op to project.</param>
    /// <returns>The projected graph.</returns>
    internal static PlanGraph Project(PlanGraph current, ReshapeOperation op)
    {
        return op switch
        {
            AddJob add => current.WithJob(add.Spec with { DependsOn = add.Dependencies.Select(d => d.ToString()).ToArray() }),
            RemoveJob rm => current.WithoutJob(rm.TargetJobId.ToString()),
            UpdateDeps upd when current.Jobs.TryGetValue(upd.TargetJobId.ToString(), out var existing)
                => current.WithJob(existing with { DependsOn = upd.NewDependencies.Select(d => d.ToString()).ToArray() }),
            UpdateDeps => current,
            AddBefore before => ApplyAddBefore(current, before),
            AddAfter after => ApplyAddAfter(current, after),
            _ => current,
        };
    }

    private static PlanGraph ApplyAddBefore(PlanGraph current, AddBefore before)
    {
        var existingKey = before.ExistingJobId.ToString();
        var newDeps = before.NewJobDependencies.Select(d => d.ToString()).ToArray();
        var newJob = before.NewJobSpec with { DependsOn = newDeps };
        var next = current.WithJob(newJob);

        if (next.Jobs.TryGetValue(existingKey, out var existing))
        {
            // Existing job now ALSO depends on the new job (prepended).
            var updatedDeps = existing.DependsOn.Contains(newJob.Id, StringComparer.Ordinal)
                ? existing.DependsOn.ToArray()
                : new[] { newJob.Id }.Concat(existing.DependsOn).ToArray();
            next = next.WithJob(existing with { DependsOn = updatedDeps });
        }

        return next;
    }

    private static PlanGraph ApplyAddAfter(PlanGraph current, AddAfter after)
    {
        var existingKey = after.ExistingJobId.ToString();
        var newJob = after.NewJobSpec with { DependsOn = new[] { existingKey } };
        var builder = current.Jobs.ToBuilder();
        builder[newJob.Id] = newJob;

        // RS-AFTER-1: rewire every previous successor of existingKey to depend on newJob.Id instead.
        foreach (var (id, node) in current.Jobs)
        {
            if (id == newJob.Id)
            {
                continue;
            }

            if (node.DependsOn.Contains(existingKey, StringComparer.Ordinal))
            {
                var rewired = node.DependsOn
                    .Select(d => string.Equals(d, existingKey, StringComparison.Ordinal) ? newJob.Id : d)
                    .Distinct(StringComparer.Ordinal)
                    .ToArray();
                builder[id] = node with { DependsOn = rewired };
            }
        }

        return new PlanGraph { Jobs = builder.ToImmutable() };
    }

    private static List<string>? FindCycle(PlanGraph graph)
    {
        const int Unvisited = 0;
        const int InStack = 1;
        const int Done = 2;

        var color = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var id in graph.Jobs.Keys)
        {
            color[id] = Unvisited;
        }

        var stack = new Stack<(string Id, IEnumerator<string> It)>();

        foreach (var start in graph.Jobs.Keys)
        {
            if (color[start] != Unvisited)
            {
                continue;
            }

            color[start] = InStack;
            stack.Push((start, graph.Jobs[start].DependsOn.GetEnumerator()));

            while (stack.Count > 0)
            {
                var (cur, it) = stack.Peek();
                if (it.MoveNext())
                {
                    var dep = it.Current;
                    if (!graph.Jobs.ContainsKey(dep))
                    {
                        // Dangling dep — not a cycle on its own.
                        continue;
                    }

                    var state = color[dep];
                    if (state == InStack)
                    {
                        // Found a back edge; reconstruct the cycle from the stack.
                        var cycle = new List<string>();
                        foreach (var frame in stack)
                        {
                            cycle.Add(frame.Id);
                            if (frame.Id == dep)
                            {
                                break;
                            }
                        }

                        cycle.Reverse();
                        return cycle;
                    }

                    if (state == Unvisited)
                    {
                        color[dep] = InStack;
                        stack.Push((dep, graph.Jobs[dep].DependsOn.GetEnumerator()));
                    }
                }
                else
                {
                    color[cur] = Done;
                    _ = stack.Pop();
                }
            }
        }

        return null;
    }

    private static JobId? TryToJobId(string s)
    {
        return JobId.TryParse(s, out var id) ? id : null;
    }
}
