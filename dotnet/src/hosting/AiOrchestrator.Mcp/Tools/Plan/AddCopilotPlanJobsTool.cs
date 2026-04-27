// <copyright file="AddCopilotPlanJobsTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Plan.Store;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>add_copilot_plan_jobs</c> — Batch-add multiple jobs to a scaffolding plan.</summary>
internal sealed class AddCopilotPlanJobsTool : PlanToolBase
{
    public AddCopilotPlanJobsTool(IPlanStoreFactory storeFactory)
        : base(
              name: "add_copilot_plan_jobs",
              description: "Batch-add multiple jobs to a scaffolding plan.",
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

        int added = 0;
        if (parameters.TryGetProperty("jobs", out var jobsEl) && jobsEl.ValueKind == JsonValueKind.Array)
        {
            foreach (var jobEl in jobsEl.EnumerateArray())
            {
                var node = ParseJobNode(jobEl);
                await store.MutateAsync(
                    planId,
                    new JobAdded(0, default, DateTimeOffset.UtcNow, node),
                    NewIdemKey(),
                    ct).ConfigureAwait(false);
                added++;
            }
        }

        return new JsonObject
        {
            ["success"] = JsonValue.Create(true),
            ["added"] = JsonValue.Create(added),
            ["message"] = JsonValue.Create($"{added} job(s) added to plan '{planId}'."),
        };
    }
}
