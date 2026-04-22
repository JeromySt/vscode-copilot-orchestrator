// <copyright file="FinalizeCopilotPlanTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>finalize_copilot_plan</c> — Validate and start a scaffolded plan.</summary>
internal sealed class FinalizeCopilotPlanTool : PlanToolBase
{
    public FinalizeCopilotPlanTool()
        : base(
              name: "finalize_copilot_plan",
              description: "Validate and start a scaffolded plan.",
              inputSchema: ObjectSchema("planId"))
    {
    }

    protected override ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct) =>
        this.StubResponseAsync();
}
