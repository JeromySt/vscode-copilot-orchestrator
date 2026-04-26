// <copyright file="ArchiveCopilotPlanTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.Store;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>archive_copilot_plan</c> — Archive a completed or canceled plan.</summary>
internal sealed class ArchiveCopilotPlanTool : PlanToolBase
{
    public ArchiveCopilotPlanTool(IPlanStore store)
        : base(
              name: "archive_copilot_plan",
              description: "Archive a completed or canceled plan.",
              inputSchema: ObjectSchema("planId"),
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

        await this.Store.MutateAsync(
            planId,
            new PlanStatusUpdated(0, default, DateTimeOffset.UtcNow, PlanStatus.Archived),
            NewIdemKey(),
            ct).ConfigureAwait(false);

        return SuccessResponse($"Plan '{planId}' archived.");
    }
}
