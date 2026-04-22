// <copyright file="AddCopilotPlanJobsTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>add_copilot_plan_jobs</c> — Batch-add multiple jobs to a scaffolding plan.</summary>
internal sealed class AddCopilotPlanJobsTool : PlanToolBase
{
    public AddCopilotPlanJobsTool()
        : base(
              name: "add_copilot_plan_jobs",
              description: "Batch-add multiple jobs to a scaffolding plan.",
              inputSchema: ObjectSchema("planId"))
    {
    }

    protected override ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct) =>
        this.StubResponseAsync();
}
