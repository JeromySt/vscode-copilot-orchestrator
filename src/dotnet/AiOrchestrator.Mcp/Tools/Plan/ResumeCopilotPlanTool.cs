// <copyright file="ResumeCopilotPlanTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>resume_copilot_plan</c> — Resume (or start) a paused or pending plan.</summary>
internal sealed class ResumeCopilotPlanTool : PlanToolBase
{
    public ResumeCopilotPlanTool()
        : base(
              name: "resume_copilot_plan",
              description: "Resume (or start) a paused or pending plan.",
              inputSchema: ObjectSchema("planId"))
    {
    }

    protected override ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct) =>
        this.StubResponseAsync();
}
