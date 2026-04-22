// <copyright file="RunCopilotIntegrationTestTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>run_copilot_integration_test</c> — Create an integration test plan with scripted output.</summary>
internal sealed class RunCopilotIntegrationTestTool : PlanToolBase
{
    public RunCopilotIntegrationTestTool()
        : base(
              name: "run_copilot_integration_test",
              description: "Create an integration test plan with scripted output.",
              inputSchema: ObjectSchema())
    {
    }

    protected override ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct) =>
        this.StubResponseAsync();
}
