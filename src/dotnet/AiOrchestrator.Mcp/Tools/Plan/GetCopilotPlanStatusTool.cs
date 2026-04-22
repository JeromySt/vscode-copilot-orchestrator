// <copyright file="GetCopilotPlanStatusTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>get_copilot_plan_status</c> — Get the status of a plan including per-node progress.</summary>
internal sealed class GetCopilotPlanStatusTool : PlanToolBase
{
    public GetCopilotPlanStatusTool()
        : base(
              name: "get_copilot_plan_status",
              description: "Get the status of a plan including per-node progress.",
              inputSchema: ObjectSchema("planId"))
    {
    }

    protected override ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct) =>
        this.StubResponseAsync();
}
