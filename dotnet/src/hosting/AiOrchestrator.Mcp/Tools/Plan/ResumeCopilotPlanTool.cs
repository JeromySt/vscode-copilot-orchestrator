// <copyright file="ResumeCopilotPlanTool.cs" company="AiOrchestrator contributors">
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

/// <summary>MCP tool: <c>resume_copilot_plan</c> — Resume (or start) a paused or pending plan.</summary>
internal sealed class ResumeCopilotPlanTool : PlanToolBase
{
    public ResumeCopilotPlanTool(IPlanStoreFactory storeFactory)
        : base(
              name: "resume_copilot_plan",
              description: "Resume (or start) a paused or pending plan.",
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
            new PlanStatusUpdated(0, default, DateTimeOffset.UtcNow, PlanStatus.Running),
            NewIdemKey(),
            ct).ConfigureAwait(false);

        return SuccessResponse($"Plan '{planId}' resumed.");
    }
}
