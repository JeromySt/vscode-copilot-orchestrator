// <copyright file="ArchiveCopilotPlanTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>archive_copilot_plan</c> — Archive a completed or canceled plan.</summary>
internal sealed class ArchiveCopilotPlanTool : PlanToolBase
{
    public ArchiveCopilotPlanTool()
        : base(
              name: "archive_copilot_plan",
              description: "Archive a completed or canceled plan.",
              inputSchema: ObjectSchema("planId"))
    {
    }

    protected override ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct) =>
        this.StubResponseAsync();
}
