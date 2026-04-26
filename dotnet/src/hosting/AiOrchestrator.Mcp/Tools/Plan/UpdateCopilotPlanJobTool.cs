// <copyright file="UpdateCopilotPlanJobTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.Store;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>MCP tool: <c>update_copilot_plan_job</c> — Update a single job's specification.</summary>
internal sealed class UpdateCopilotPlanJobTool : PlanToolBase
{
    public UpdateCopilotPlanJobTool(IPlanStore store)
        : base(
              name: "update_copilot_plan_job",
              description: "Update a single job's specification.",
              inputSchema: ObjectSchema("planId", "jobId"),
              store: store)
    {
    }

    protected override async ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct)
    {
        var planId = ParsePlanId(parameters);
        string jobId = parameters.GetProperty("jobId").GetString()!;
        var plan = await this.Store.LoadAsync(planId, ct).ConfigureAwait(false);
        if (plan is null)
        {
            return ErrorResponse($"Plan '{planId}' not found.");
        }

        if (!plan.Jobs.ContainsKey(jobId))
        {
            return ErrorResponse($"Job '{jobId}' not found in plan '{planId}'.");
        }

        // Apply status update if provided.
        if (parameters.TryGetProperty("status", out var statusEl))
        {
            string statusStr = statusEl.GetString() ?? string.Empty;
            if (Enum.TryParse<JobStatus>(statusStr, ignoreCase: true, out var newStatus))
            {
                await this.Store.MutateAsync(
                    planId,
                    new JobStatusUpdated(0, default, DateTimeOffset.UtcNow, jobId, newStatus),
                    NewIdemKey(),
                    ct).ConfigureAwait(false);
            }
        }

        // Apply dependency update if provided.
        if (parameters.TryGetProperty("dependencies", out var depsEl) && depsEl.ValueKind == JsonValueKind.Array)
        {
            var deps = new List<string>();
            foreach (var d in depsEl.EnumerateArray())
            {
                string? val = d.GetString();
                if (val is not null)
                {
                    deps.Add(val);
                }
            }

            await this.Store.MutateAsync(
                planId,
                new JobDepsUpdated(0, default, DateTimeOffset.UtcNow, jobId, [.. deps]),
                NewIdemKey(),
                ct).ConfigureAwait(false);
        }

        return SuccessResponse($"Job '{jobId}' updated in plan '{planId}'.");
    }
}
