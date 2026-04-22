// <copyright file="DeleteCopilotPlanTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>delete_copilot_plan</c> — Delete a plan and its associated artifacts.</summary>
internal sealed class DeleteCopilotPlanTool : PlanToolBase
{
    public DeleteCopilotPlanTool()
        : base(
              name: "delete_copilot_plan",
              description: "Delete a plan and its associated artifacts.",
              inputSchema: ObjectSchema("planId"))
    {
    }

    protected override ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct) =>
        this.StubResponseAsync();
}
