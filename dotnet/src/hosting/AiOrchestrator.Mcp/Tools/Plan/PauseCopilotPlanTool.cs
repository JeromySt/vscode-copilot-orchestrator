// <copyright file="PauseCopilotPlanTool.cs" company="AiOrchestrator contributors">
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

/// <summary>MCP tool: <c>pause_copilot_plan</c> — Pause a running plan.</summary>
internal sealed class PauseCopilotPlanTool : PlanToolBase
{
    public PauseCopilotPlanTool(IPlanStoreFactory storeFactory)
        : base(
              name: "pause_copilot_plan",
              description: "Pause a running plan.",
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
            new PlanStatusUpdated(0, default, DateTimeOffset.UtcNow, PlanStatus.Paused),
            NewIdemKey(),
            ct).ConfigureAwait(false);

        return SuccessResponse($"Plan '{planId}' paused.");
    }
}
