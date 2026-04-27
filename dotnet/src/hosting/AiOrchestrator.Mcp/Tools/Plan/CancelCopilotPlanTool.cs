// <copyright file="CancelCopilotPlanTool.cs" company="AiOrchestrator contributors">
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

/// <summary>MCP tool: <c>cancel_copilot_plan</c> — Cancel a running plan and all of its jobs.</summary>
internal sealed class CancelCopilotPlanTool : PlanToolBase
{
    public CancelCopilotPlanTool(IPlanStoreFactory storeFactory)
        : base(
              name: "cancel_copilot_plan",
              description: "Cancel a running plan and all of its jobs.",
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

        await store.MutateAsync(
            planId,
            new PlanStatusUpdated(0, default, DateTimeOffset.UtcNow, PlanStatus.Canceled),
            NewIdemKey(),
            ct).ConfigureAwait(false);

        return SuccessResponse($"Plan '{planId}' canceled.");
    }
}
