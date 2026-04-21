// <copyright file="UpdateCopilotPlanTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>update_copilot_plan</c> — Update plan-level settings such as env vars or concurrency.</summary>
internal sealed class UpdateCopilotPlanTool : PlanToolBase
{
    public UpdateCopilotPlanTool()
        : base(
              name: "update_copilot_plan",
              description: "Update plan-level settings such as env vars or concurrency.",
              inputSchema: ObjectSchema("planId"))
    {
    }

    protected override ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct) =>
        this.StubResponseAsync();
}
