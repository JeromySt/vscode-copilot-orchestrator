// <copyright file="BulkUpdateCopilotPlanJobsTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>bulk_update_copilot_plan_jobs</c> — Apply common AgentSpec attributes to multiple jobs at once.</summary>
internal sealed class BulkUpdateCopilotPlanJobsTool : PlanToolBase
{
    public BulkUpdateCopilotPlanJobsTool()
        : base(
              name: "bulk_update_copilot_plan_jobs",
              description: "Apply common AgentSpec attributes to multiple jobs at once.",
              inputSchema: ObjectSchema("planId"))
    {
    }

    protected override ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct) =>
        this.StubResponseAsync();
}
