// <copyright file="UpdateCopilotPlanTool.cs" company="AiOrchestrator contributors">
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

/// <summary>MCP tool: <c>update_copilot_plan</c> — Update plan-level settings such as env vars or concurrency.</summary>
internal sealed class UpdateCopilotPlanTool : PlanToolBase
{
    public UpdateCopilotPlanTool(IPlanStoreFactory storeFactory)
        : base(
              name: "update_copilot_plan",
              description: "Update plan-level settings such as env vars or concurrency.",
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

        // The journaled store supports status mutations. Apply status change if requested.
        if (parameters.TryGetProperty("status", out var statusEl))
        {
            string statusStr = statusEl.GetString() ?? string.Empty;
            if (Enum.TryParse<PlanStatus>(statusStr, ignoreCase: true, out var newStatus))
            {
                await store.MutateAsync(
                    planId,
                    new PlanStatusUpdated(0, default, DateTimeOffset.UtcNow, newStatus),
                    NewIdemKey(),
                    ct).ConfigureAwait(false);
            }
        }

        return SuccessResponse($"Plan '{planId}' updated.");
    }
}
