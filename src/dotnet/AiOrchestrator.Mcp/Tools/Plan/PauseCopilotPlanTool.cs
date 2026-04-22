// <copyright file="PauseCopilotPlanTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>pause_copilot_plan</c> — Pause a running plan.</summary>
internal sealed class PauseCopilotPlanTool : PlanToolBase
{
    public PauseCopilotPlanTool()
        : base(
              name: "pause_copilot_plan",
              description: "Pause a running plan.",
              inputSchema: ObjectSchema("planId"))
    {
    }

    protected override ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct) =>
        this.StubResponseAsync();
}
