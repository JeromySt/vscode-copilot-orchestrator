// <copyright file="FinalizeCopilotPlanTool.cs" company="AiOrchestrator contributors">
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

/// <summary>MCP tool: <c>finalize_copilot_plan</c> — Validate and start a scaffolded plan.</summary>
internal sealed class FinalizeCopilotPlanTool : PlanToolBase
{
    public FinalizeCopilotPlanTool(IPlanStoreFactory storeFactory)
        : base(
              name: "finalize_copilot_plan",
              description: "Validate and start a scaffolded plan.",
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

        bool startPaused = parameters.TryGetProperty("startPaused", out var sp) && sp.GetBoolean();
        var newStatus = startPaused ? PlanStatus.PendingStart : PlanStatus.Pending;

        await store.MutateAsync(
            planId,
            new PlanStatusUpdated(0, default, DateTimeOffset.UtcNow, newStatus),
            NewIdemKey(),
            ct).ConfigureAwait(false);

        return new JsonObject
        {
            ["success"] = true,
            ["plan_id"] = planId.ToString(),
            ["name"] = plan.Name,
            ["status"] = newStatus.ToString(),
            ["paused"] = startPaused,
            ["message"] = $"Plan finalized with {plan.Jobs.Count} jobs.",
            ["jobCount"] = plan.Jobs.Count,
        };
    }
}
