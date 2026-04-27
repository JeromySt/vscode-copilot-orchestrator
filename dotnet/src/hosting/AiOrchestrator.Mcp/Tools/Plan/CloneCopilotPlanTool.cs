// <copyright file="CloneCopilotPlanTool.cs" company="AiOrchestrator contributors">
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

/// <summary>MCP tool: <c>clone_copilot_plan</c> — Duplicate an existing plan as a new scaffolding plan.</summary>
internal sealed class CloneCopilotPlanTool : PlanToolBase
{
    public CloneCopilotPlanTool(IPlanStoreFactory storeFactory)
        : base(
              name: "clone_copilot_plan",
              description: "Duplicate an existing plan as a new scaffolding plan.",
              inputSchema: ObjectSchema("planId"),
              storeFactory: storeFactory)
    {
    }

    protected override async ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct)
    {
        var store = this.GetStore(parameters);
        var sourcePlanId = ParsePlanId(parameters);
        var source = await store.LoadAsync(sourcePlanId, ct).ConfigureAwait(false);
        if (source is null)
        {
            return ErrorResponse($"Source plan '{sourcePlanId}' not found.");
        }

        string cloneName = parameters.TryGetProperty("name", out var n)
            ? n.GetString() ?? $"{source.Name} (clone)"
            : $"{source.Name} (clone)";

        // Create a new plan in Scaffolding status.
        var clonePlan = new AiOrchestrator.Plan.Models.Plan
        {
            Name = cloneName,
            Description = source.Description,
            Status = PlanStatus.Scaffolding,
            CreatedAt = DateTimeOffset.UtcNow,
        };

        var newPlanId = await store.CreateAsync(clonePlan, NewIdemKey(), ct).ConfigureAwait(false);

        // Clone all jobs from source.
        foreach (var (_, job) in source.Jobs)
        {
            var clonedJob = new JobNode
            {
                Id = job.Id,
                Title = job.Title,
                Status = JobStatus.Pending,
                DependsOn = job.DependsOn,
                WorkSpec = job.WorkSpec,
            };

            await store.MutateAsync(
                newPlanId,
                new JobAdded(0, default, DateTimeOffset.UtcNow, clonedJob),
                NewIdemKey(),
                ct).ConfigureAwait(false);
        }

        return new JsonObject
        {
            ["success"] = JsonValue.Create(true),
            ["plan_id"] = JsonValue.Create(newPlanId.ToString()),
            ["source_plan_id"] = JsonValue.Create(sourcePlanId.ToString()),
            ["name"] = JsonValue.Create(cloneName),
            ["jobsCloned"] = JsonValue.Create(source.Jobs.Count),
        };
    }
}
