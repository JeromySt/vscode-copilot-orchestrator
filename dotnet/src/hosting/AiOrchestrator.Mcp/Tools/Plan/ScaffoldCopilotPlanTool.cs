// <copyright file="ScaffoldCopilotPlanTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Plan.Store;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>scaffold_copilot_plan</c> — Create an empty plan scaffold for incremental job building.</summary>
internal sealed class ScaffoldCopilotPlanTool : PlanToolBase
{
    public ScaffoldCopilotPlanTool(IPlanStore store)
        : base(
              name: "scaffold_copilot_plan",
              description: "Create an empty plan scaffold for incremental job building.",
              inputSchema: ObjectSchema(),
              store: store)
    {
    }

    protected override async ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct)
    {
        string name = parameters.TryGetProperty("name", out var n) ? n.GetString() ?? "Untitled Plan" : "Untitled Plan";

        var plan = new AiOrchestrator.Plan.Models.Plan
        {
            Name = name,
            Status = AiOrchestrator.Plan.Models.PlanStatus.Scaffolding,
            CreatedAt = DateTimeOffset.UtcNow,
        };

        var planId = await this.Store.CreateAsync(plan, NewIdemKey(), ct).ConfigureAwait(false);

        return new JsonObject
        {
            ["success"] = true,
            ["plan_id"] = planId.ToString(),
            ["name"] = name,
            ["status"] = "Scaffolding",
        };
    }
}
