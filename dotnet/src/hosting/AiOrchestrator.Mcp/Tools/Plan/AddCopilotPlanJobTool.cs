// <copyright file="AddCopilotPlanJobTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Plan.Store;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>add_copilot_plan_job</c> — Add a single job to a scaffolding plan.</summary>
internal sealed class AddCopilotPlanJobTool : PlanToolBase
{
    public AddCopilotPlanJobTool(IPlanStore store)
        : base(
              name: "add_copilot_plan_job",
              description: "Add a single job to a scaffolding plan.",
              inputSchema: ObjectSchema("planId", "producerId"),
              store: store)
    {
    }

    protected override async ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct)
    {
        var planId = ParsePlanId(parameters);
        var plan = await this.Store.LoadAsync(planId, ct).ConfigureAwait(false);
        if (plan is null)
        {
            return ErrorResponse($"Plan '{planId}' not found.");
        }

        var node = ParseJobNode(parameters);

        await this.Store.MutateAsync(
            planId,
            new JobAdded(0, default, DateTimeOffset.UtcNow, node),
            NewIdemKey(),
            ct).ConfigureAwait(false);

        return new JsonObject
        {
            ["success"] = true,
            ["jobId"] = node.Id,
            ["message"] = $"Job '{node.Id}' added to plan '{planId}'.",
        };
    }
}
