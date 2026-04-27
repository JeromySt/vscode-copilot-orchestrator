// <copyright file="BulkUpdateCopilotPlanJobsTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.Store;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>bulk_update_copilot_plan_jobs</c> — Apply common AgentSpec attributes to multiple jobs at once.</summary>
internal sealed class BulkUpdateCopilotPlanJobsTool : PlanToolBase
{
    public BulkUpdateCopilotPlanJobsTool(IPlanStoreFactory storeFactory)
        : base(
              name: "bulk_update_copilot_plan_jobs",
              description: "Apply common AgentSpec attributes to multiple jobs at once.",
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

        // Determine which jobs to update.
        var jobIds = new System.Collections.Generic.List<string>();
        if (parameters.TryGetProperty("jobIds", out var idsEl) && idsEl.ValueKind == JsonValueKind.Array)
        {
            foreach (var id in idsEl.EnumerateArray())
            {
                string? val = id.GetString();
                if (val is not null)
                {
                    jobIds.Add(val);
                }
            }
        }
        else
        {
            // All jobs.
            foreach (var (id, _) in plan.Jobs)
            {
                jobIds.Add(id);
            }
        }

        int updated = 0;
        if (parameters.TryGetProperty("status", out var statusEl))
        {
            string statusStr = statusEl.GetString() ?? string.Empty;
            if (Enum.TryParse<JobStatus>(statusStr, ignoreCase: true, out var newStatus))
            {
                foreach (string jid in jobIds)
                {
                    if (plan.Jobs.ContainsKey(jid))
                    {
                        await store.MutateAsync(
                            planId,
                            new JobStatusUpdated(0, default, DateTimeOffset.UtcNow, jid, newStatus),
                            NewIdemKey(),
                            ct).ConfigureAwait(false);
                        updated++;
                    }
                }
            }
        }

        return new JsonObject
        {
            ["success"] = JsonValue.Create(true),
            ["updated"] = JsonValue.Create(updated),
            ["message"] = JsonValue.Create($"{updated} job(s) updated in plan '{planId}'."),
        };
    }
}
