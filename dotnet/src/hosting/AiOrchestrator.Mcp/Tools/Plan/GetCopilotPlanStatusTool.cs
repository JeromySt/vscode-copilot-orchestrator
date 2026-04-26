// <copyright file="GetCopilotPlanStatusTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Plan.Store;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>get_copilot_plan_status</c> — Get the status of a plan including per-node progress.</summary>
internal sealed class GetCopilotPlanStatusTool : PlanToolBase
{
    public GetCopilotPlanStatusTool(IPlanStore store)
        : base(
              name: "get_copilot_plan_status",
              description: "Get the status of a plan including per-node progress.",
              inputSchema: ObjectSchema("planId"),
              store: store)
    {
    }

    protected override async ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct)
    {
        var planId = ParsePlanId(parameters);
        var plan = await this.Store.LoadAsync(planId, ct).ConfigureAwait(false);
        if (plan is null)
        {
            return ErrorResponse($"Plan '{planId}' not found.");
        }

        return PlanToJson(plan);
    }
}
