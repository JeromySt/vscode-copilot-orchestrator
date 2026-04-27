// <copyright file="GetCopilotJobProcessTreeTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Plan.Store;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>
/// MCP tool: <c>get_copilot_job_process_tree</c> — Returns the process tree for a running job.
/// The response shape matches the TS <c>ProcessNode</c> interface consumed by the webview UI.
/// </summary>
internal sealed class GetCopilotJobProcessTreeTool : PlanToolBase
{
    private readonly IProcessHandleRegistry? registry;

    public GetCopilotJobProcessTreeTool(IPlanStoreFactory storeFactory, IProcessHandleRegistry? registry = null)
        : base(
              name: "get_copilot_job_process_tree",
              description: "Get the process tree (PIDs, CPU, memory) for a running job.",
              inputSchema: ObjectSchema("planId", "jobId"),
              storeFactory: storeFactory)
    {
        this.registry = registry;
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

        if (this.registry is null)
        {
            return new JsonObject
            {
                ["error"] = JsonValue.Create("process_tree_not_available"),
                ["reason"] = JsonValue.Create("Process handle registry not configured."),
            };
        }

        var handle = this.registry.Get(planId, jobId);
        if (handle is null)
        {
            return new JsonObject
            {
                ["error"] = JsonValue.Create("process_tree_not_available"),
                ["reason"] = JsonValue.Create("Job not running or handle not tracked."),
            };
        }

        ProcessTreeNode? tree;
        try
        {
            tree = await handle.GetProcessTreeAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new JsonObject
            {
                ["error"] = JsonValue.Create("process_tree_not_available"),
                ["reason"] = JsonValue.Create(ex.Message),
            };
        }

        if (tree is null)
        {
            return new JsonObject
            {
                ["error"] = JsonValue.Create("process_tree_not_available"),
                ["reason"] = JsonValue.Create("Process has exited."),
            };
        }

        return ToJson(tree);
    }

    /// <summary>
    /// Serializes a <see cref="ProcessTreeNode"/> into the TS <c>ProcessNode</c> shape:
    /// <c>{ pid, name, cpu, memory, commandLine, children }</c>.
    /// </summary>
    private static JsonNode ToJson(ProcessTreeNode node)
    {
        var children = new JsonArray();
        foreach (var child in node.Children)
        {
            children.Add(ToJson(child));
        }

        return new JsonObject
        {
            ["pid"] = JsonValue.Create(node.Stats.Pid),
            ["name"] = JsonValue.Create(node.Stats.Name),
            ["cpu"] = JsonValue.Create(node.Stats.CpuPercent),
            ["memory"] = JsonValue.Create(node.Stats.MemoryBytes),
            ["commandLine"] = JsonValue.Create(node.Stats.CommandLine),
            ["children"] = children,
        };
    }
}
