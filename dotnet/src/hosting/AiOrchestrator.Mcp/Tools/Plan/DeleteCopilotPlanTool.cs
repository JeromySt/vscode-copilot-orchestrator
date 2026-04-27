// <copyright file="DeleteCopilotPlanTool.cs" company="AiOrchestrator contributors">
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

/// <summary>MCP tool: <c>delete_copilot_plan</c> — Delete a plan and its associated artifacts.</summary>
internal sealed class DeleteCopilotPlanTool : PlanToolBase
{
    public DeleteCopilotPlanTool(IPlanStoreFactory storeFactory)
        : base(
              name: "delete_copilot_plan",
              description: "Delete a plan and its associated artifacts.",
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

        // IPlanStore does not expose a hard delete; transition to Archived as a soft delete.
        await store.MutateAsync(
            planId,
            new PlanStatusUpdated(0, default, DateTimeOffset.UtcNow, PlanStatus.Archived),
            NewIdemKey(),
            ct).ConfigureAwait(false);

        return SuccessResponse($"Plan '{planId}' deleted (archived).");
    }
}
