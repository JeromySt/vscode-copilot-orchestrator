// <copyright file="UpdateCopilotPlanJobTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>update_copilot_plan_job</c> — Update a single job's specification.</summary>
internal sealed class UpdateCopilotPlanJobTool : PlanToolBase
{
    public UpdateCopilotPlanJobTool()
        : base(
              name: "update_copilot_plan_job",
              description: "Update a single job's specification.",
              inputSchema: ObjectSchema("planId", "jobId"))
    {
    }

    protected override ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct) =>
        this.StubResponseAsync();
}
