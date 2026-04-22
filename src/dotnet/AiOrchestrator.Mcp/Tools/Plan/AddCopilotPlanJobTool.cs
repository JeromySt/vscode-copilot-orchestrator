// <copyright file="AddCopilotPlanJobTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>add_copilot_plan_job</c> — Add a single job to a scaffolding plan.</summary>
internal sealed class AddCopilotPlanJobTool : PlanToolBase
{
    public AddCopilotPlanJobTool()
        : base(
              name: "add_copilot_plan_job",
              description: "Add a single job to a scaffolding plan.",
              inputSchema: ObjectSchema("planId", "producerId"))
    {
    }

    protected override ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct) =>
        this.StubResponseAsync();
}
