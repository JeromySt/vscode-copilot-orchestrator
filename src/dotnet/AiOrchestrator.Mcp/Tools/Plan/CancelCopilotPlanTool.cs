// <copyright file="CancelCopilotPlanTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>cancel_copilot_plan</c> — Cancel a running plan and all of its jobs.</summary>
internal sealed class CancelCopilotPlanTool : PlanToolBase
{
    public CancelCopilotPlanTool()
        : base(
              name: "cancel_copilot_plan",
              description: "Cancel a running plan and all of its jobs.",
              inputSchema: ObjectSchema("planId"))
    {
    }

    protected override ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct) =>
        this.StubResponseAsync();
}
