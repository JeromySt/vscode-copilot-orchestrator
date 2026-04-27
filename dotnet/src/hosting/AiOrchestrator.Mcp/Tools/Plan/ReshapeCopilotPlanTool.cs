// <copyright file="ReshapeCopilotPlanTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.Store;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>reshape_copilot_plan</c> — Reshape a running or paused plan's DAG topology.</summary>
internal sealed class ReshapeCopilotPlanTool : PlanToolBase
{
    public ReshapeCopilotPlanTool(IPlanStoreFactory storeFactory)
        : base(
              name: "reshape_copilot_plan",
              description: "Reshape a running or paused plan's DAG topology.",
              inputSchema: ObjectSchema("planId"),
              storeFactory: storeFactory)
    {
    }

    protected override async ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct)
    {
        var store = this.GetStore(parameters);
        var planId = ParsePlanId(parameters);
        var plan = await store.LoadAsync(planId, ct).ConfigureAwait(false);
        if (plan is null)
        {
            return ErrorResponse($"Plan '{planId}' not found.");
        }

        int applied = 0;
        if (parameters.TryGetProperty("operations", out var opsEl) && opsEl.ValueKind == JsonValueKind.Array)
        {
            foreach (var op in opsEl.EnumerateArray())
            {
                string opType = op.TryGetProperty("type", out var t) ? t.GetString() ?? string.Empty : string.Empty;
                switch (opType)
                {
                    case "add_job":
                        if (op.TryGetProperty("spec", out var specEl))
                        {
                            var node = ParseJobNode(specEl);
                            await store.MutateAsync(
                                planId,
                                new JobAdded(0, default, DateTimeOffset.UtcNow, node),
                                NewIdemKey(),
                                ct).ConfigureAwait(false);
                            applied++;
                        }

                        break;

                    case "remove_job":
                        string? removeId = op.TryGetProperty("jobId", out var jid) ? jid.GetString()
                            : op.TryGetProperty("producerId", out var pid) ? pid.GetString() : null;
                        if (removeId is not null)
                        {
                            await store.MutateAsync(
                                planId,
                                new JobRemoved(0, default, DateTimeOffset.UtcNow, removeId),
                                NewIdemKey(),
                                ct).ConfigureAwait(false);
                            applied++;
                        }

                        break;

                    case "update_deps":
                        string? depsJobId = op.TryGetProperty("jobId", out var dj) ? dj.GetString() : null;
                        if (depsJobId is not null && op.TryGetProperty("dependencies", out var depsArr) && depsArr.ValueKind == JsonValueKind.Array)
                        {
                            var deps = new List<string>();
                            foreach (var d in depsArr.EnumerateArray())
                            {
                                string? val = d.GetString();
                                if (val is not null)
                                {
                                    deps.Add(val);
                                }
                            }

                            await store.MutateAsync(
                                planId,
                                new JobDepsUpdated(0, default, DateTimeOffset.UtcNow, depsJobId, [.. deps]),
                                NewIdemKey(),
                                ct).ConfigureAwait(false);
                            applied++;
                        }

                        break;
                }
            }
        }

        return new JsonObject
        {
            ["success"] = true,
            ["applied"] = applied,
            ["message"] = $"{applied} operation(s) applied to plan '{planId}'.",
        };
    }
}
