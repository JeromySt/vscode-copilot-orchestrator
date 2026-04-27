// <copyright file="ForceFailCopilotJobTool.cs" company="AiOrchestrator contributors">
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

/// <summary>MCP tool: <c>force_fail_copilot_job</c> — Force a stuck running job to failed state.</summary>
internal sealed class ForceFailCopilotJobTool : PlanToolBase
{
    public ForceFailCopilotJobTool(IPlanStoreFactory storeFactory)
        : base(
              name: "force_fail_copilot_job",
              description: "Force a stuck running job to failed state.",
              inputSchema: ObjectSchema("planId", "jobId"),
              storeFactory: storeFactory)
    {
    }

    protected override async ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct)
    {
        var store = this.GetStore(parameters);
        var planId = ParsePlanId(parameters);
        string jobId = parameters.GetProperty("jobId").GetString()!;
        var plan = await store.LoadAsync(planId, ct).ConfigureAwait(false);
        if (plan is null)
        {
            return ErrorResponse($"Plan '{planId}' not found.");
        }

        if (!plan.Jobs.ContainsKey(jobId))
        {
            return ErrorResponse($"Job '{jobId}' not found in plan '{planId}'.");
        }

        await store.MutateAsync(
            planId,
            new JobStatusUpdated(0, default, DateTimeOffset.UtcNow, jobId, JobStatus.Failed),
            NewIdemKey(),
            ct).ConfigureAwait(false);

        return SuccessResponse($"Job '{jobId}' forced to failed state.");
    }
}
