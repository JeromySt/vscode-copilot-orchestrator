// <copyright file="ReshapeCopilotPlanTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>reshape_copilot_plan</c> — Reshape a running or paused plan's DAG topology.</summary>
internal sealed class ReshapeCopilotPlanTool : PlanToolBase
{
    public ReshapeCopilotPlanTool()
        : base(
              name: "reshape_copilot_plan",
              description: "Reshape a running or paused plan's DAG topology.",
              inputSchema: ObjectSchema("planId"))
    {
    }

    protected override ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct) =>
        this.StubResponseAsync();
}
