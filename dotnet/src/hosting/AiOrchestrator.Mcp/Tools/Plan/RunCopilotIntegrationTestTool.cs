// <copyright file="RunCopilotIntegrationTestTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.Store;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>run_copilot_integration_test</c> — Create an integration test plan with scripted output.</summary>
internal sealed class RunCopilotIntegrationTestTool : PlanToolBase
{
    public RunCopilotIntegrationTestTool(IPlanStoreFactory storeFactory)
        : base(
              name: "run_copilot_integration_test",
              description: "Create an integration test plan with scripted output.",
              inputSchema: ObjectSchema(),
              storeFactory: storeFactory)
    {
    }

    protected override async ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct)
    {
        string name = parameters.TryGetProperty("name", out var n)
            ? n.GetString() ?? "Integration Test Plan"
            : "Integration Test Plan";

        var plan = new AiOrchestrator.Plan.Models.Plan
        {
            Name = name,
            Description = "Auto-generated integration test plan.",
            Status = PlanStatus.Scaffolding,
            CreatedAt = DateTimeOffset.UtcNow,
        };

        var store = this.GetStore(parameters);
        var planId = await store.CreateAsync(plan, NewIdemKey(), ct).ConfigureAwait(false);

        // Add sample test jobs.
        var jobs = new (string Id, string Title, string[] Deps)[]
        {
            ("setup", "Setup test environment", []),
            ("test-a", "Test scenario A", ["setup"]),
            ("test-b", "Test scenario B", ["setup"]),
            ("verify", "Verify results", ["test-a", "test-b"]),
        };

        foreach (var (id, title, deps) in jobs)
        {
            var node = new JobNode
            {
                Id = id,
                Title = title,
                Status = JobStatus.Pending,
                DependsOn = deps,
            };

            await store.MutateAsync(
                planId,
                new JobAdded(0, default, DateTimeOffset.UtcNow, node),
                NewIdemKey(),
                ct).ConfigureAwait(false);
        }

        return new JsonObject
        {
            ["success"] = JsonValue.Create(true),
            ["plan_id"] = JsonValue.Create(planId.ToString()),
            ["name"] = JsonValue.Create(name),
            ["status"] = JsonValue.Create("Scaffolding"),
            ["jobCount"] = JsonValue.Create(jobs.Length),
        };
    }
}
