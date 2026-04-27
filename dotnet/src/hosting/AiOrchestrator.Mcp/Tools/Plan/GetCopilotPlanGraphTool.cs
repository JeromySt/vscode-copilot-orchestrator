// <copyright file="GetCopilotPlanGraphTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Plan.Store;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>get_copilot_plan_graph</c> — Get the dependency graph of a plan as Mermaid and adjacency list.</summary>
internal sealed class GetCopilotPlanGraphTool : PlanToolBase
{
    public GetCopilotPlanGraphTool(IPlanStoreFactory storeFactory)
        : base(
              name: "get_copilot_plan_graph",
              description: "Get the dependency graph of a plan as Mermaid and adjacency list.",
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

        return PlanGraphToJson(plan);
    }
}
