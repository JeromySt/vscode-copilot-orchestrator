// <copyright file="CloneCopilotPlanTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>clone_copilot_plan</c> — Duplicate an existing plan as a new scaffolding plan.</summary>
internal sealed class CloneCopilotPlanTool : PlanToolBase
{
    public CloneCopilotPlanTool()
        : base(
              name: "clone_copilot_plan",
              description: "Duplicate an existing plan as a new scaffolding plan.",
              inputSchema: ObjectSchema("planId"))
    {
    }

    protected override ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct) =>
        this.StubResponseAsync();
}
