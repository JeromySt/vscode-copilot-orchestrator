// <copyright file="ForceFailCopilotJobTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>force_fail_copilot_job</c> — Force a stuck running job to failed state.</summary>
internal sealed class ForceFailCopilotJobTool : PlanToolBase
{
    public ForceFailCopilotJobTool()
        : base(
              name: "force_fail_copilot_job",
              description: "Force a stuck running job to failed state.",
              inputSchema: ObjectSchema("planId", "jobId"))
    {
    }

    protected override ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct) =>
        this.StubResponseAsync();
}
