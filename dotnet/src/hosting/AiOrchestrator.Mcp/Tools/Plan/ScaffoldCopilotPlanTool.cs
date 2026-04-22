// <copyright file="ScaffoldCopilotPlanTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>scaffold_copilot_plan</c> — Create an empty plan scaffold for incremental job building.</summary>
internal sealed class ScaffoldCopilotPlanTool : PlanToolBase
{
    public ScaffoldCopilotPlanTool()
        : base(
              name: "scaffold_copilot_plan",
              description: "Create an empty plan scaffold for incremental job building.",
              inputSchema: ObjectSchema())
    {
    }

    protected override ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct) =>
        this.StubResponseAsync();
}
