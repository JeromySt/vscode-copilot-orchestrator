// <copyright file="PlanToolBase.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.Store;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>
/// Base class shared by the plan/job MCP tools. Each concrete tool sets its immutable
/// identity (name/description/schema) and overrides <see cref="InvokeCoreAsync"/> to
/// perform the tool-specific work by delegating to the <see cref="IPlanStore"/>.
/// </summary>
internal abstract class PlanToolBase : IMcpTool
{
    private readonly IPlanStoreFactory? storeFactory;

    protected PlanToolBase(string name, string description, JsonNode inputSchema, IPlanStoreFactory storeFactory)
        : this(name, description, inputSchema)
    {
        this.storeFactory = storeFactory ?? throw new ArgumentNullException(nameof(storeFactory));
    }

    /// <summary>Backwards-compatible constructor for subclasses that do not require a store (e.g. test helpers).</summary>
    protected PlanToolBase(string name, string description, JsonNode inputSchema)
    {
        this.Name = name;
        this.Description = description;
        this.InputSchema = inputSchema;
    }

    /// <summary>Gets the tool name.</summary>
    public string Name { get; }

    /// <summary>Gets the tool description.</summary>
    public string Description { get; }

    /// <summary>Gets the JSON Schema describing the tool's input parameters.</summary>
    public JsonNode InputSchema { get; }

    /// <summary>Gets the store factory. Throws if none was provided.</summary>
    protected IPlanStoreFactory StoreFactory => this.storeFactory ?? throw new InvalidOperationException("No IPlanStoreFactory was provided.");

    /// <summary>
    /// Resolves an <see cref="IPlanStore"/> for the repository identified by the
    /// <c>repo_root</c> property in <paramref name="parameters"/>.
    /// </summary>
    protected IPlanStore GetStore(JsonElement parameters)
    {
        var repoRoot = ParseRepoRoot(parameters);
        if (string.IsNullOrEmpty(repoRoot))
        {
            throw new InvalidOperationException("repo_root is required");
        }

        return this.StoreFactory.GetStore(repoRoot);
    }

    /// <summary>Extracts the optional <c>repo_root</c> string from the tool parameters.</summary>
    protected static string? ParseRepoRoot(JsonElement parameters)
    {
        return parameters.TryGetProperty("repo_root", out var elem) && elem.ValueKind == JsonValueKind.String
            ? elem.GetString()
            : null;
    }

    /// <inheritdoc/>
    public ValueTask<JsonNode> InvokeAsync(JsonElement parameters, CancellationToken ct) =>
        this.InvokeCoreAsync(parameters, ct);

    /// <summary>Helper: builds an object schema with the specified required string properties. Always includes an optional <c>repo_root</c> property.</summary>
    protected static JsonNode ObjectSchema(params string[] requiredStringProps)
    {
        var props = new JsonObject();
        var required = new JsonArray();
        foreach (string p in requiredStringProps)
        {
            props[p] = new JsonObject { ["type"] = "string" };
            required.Add(p);
        }

        // Every tool accepts repo_root so the daemon can be repo-agnostic.
        props["repo_root"] = new JsonObject
        {
            ["type"] = "string",
            ["description"] = "Absolute path to the repository root for repo-scoped operations.",
        };

        return new JsonObject
        {
            ["type"] = "object",
            ["properties"] = props,
            ["required"] = required,
            ["additionalProperties"] = true,
        };
    }

    protected abstract ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct);

    /// <summary>Parses a <see cref="PlanId"/> from the <c>planId</c> property of the JSON parameters.</summary>
    protected static PlanId ParsePlanId(JsonElement parameters) =>
        PlanId.Parse(parameters.GetProperty("planId").GetString()!);

    /// <summary>Creates an error response JSON object.</summary>
    protected static JsonNode ErrorResponse(string message) =>
        new JsonObject { ["success"] = false, ["error"] = message };

    /// <summary>Creates a success response JSON object.</summary>
    protected static JsonNode SuccessResponse(string message = "ok") =>
        new JsonObject { ["success"] = true, ["message"] = message };

    /// <summary>Creates a fresh idempotency key from a new <see cref="Guid"/>.</summary>
    protected static IdempotencyKey NewIdemKey() => IdempotencyKey.FromGuid(Guid.NewGuid());

    /// <summary>Serializes a <see cref="AiOrchestrator.Plan.Models.Plan"/> to a JSON response.</summary>
    protected static JsonNode PlanToJson(AiOrchestrator.Plan.Models.Plan plan)
    {
        var jobs = new JsonObject();
        foreach (var (id, job) in plan.Jobs)
        {
            var deps = new JsonArray();
            foreach (string d in job.DependsOn)
            {
                deps.Add(d);
            }

            jobs[id] = new JsonObject
            {
                ["id"] = job.Id,
                ["title"] = job.Title,
                ["status"] = job.Status.ToString(),
                ["dependsOn"] = deps,
                ["startedAt"] = job.StartedAt?.ToString("o"),
                ["completedAt"] = job.CompletedAt?.ToString("o"),
            };
        }

        var statusCounts = new JsonObject();
        foreach (var group in plan.Jobs.Values.GroupBy(j => j.Status))
        {
            statusCounts[group.Key.ToString()] = group.Count();
        }

        return new JsonObject
        {
            ["success"] = true,
            ["plan_id"] = plan.Id,
            ["name"] = plan.Name,
            ["description"] = plan.Description,
            ["status"] = plan.Status.ToString(),
            ["createdAt"] = plan.CreatedAt.ToString("o"),
            ["startedAt"] = plan.StartedAt?.ToString("o"),
            ["jobCount"] = plan.Jobs.Count,
            ["statusCounts"] = statusCounts,
            ["jobs"] = jobs,
        };
    }

    /// <summary>Builds a Mermaid flowchart and adjacency list for the plan's DAG.</summary>
    protected static JsonNode PlanGraphToJson(AiOrchestrator.Plan.Models.Plan plan)
    {
        var sb = new StringBuilder();
        sb.AppendLine("flowchart LR");
        foreach (var (id, job) in plan.Jobs)
        {
            string icon = job.Status switch
            {
                JobStatus.Succeeded => "✅",
                JobStatus.Failed => "❌",
                JobStatus.Running => "🔄",
                JobStatus.Canceled => "🚫",
                _ => "⏳",
            };
            sb.AppendLine($"    {id}[\"{icon} {job.Title}\"]");
            foreach (string dep in job.DependsOn)
            {
                sb.AppendLine($"    {dep} --> {id}");
            }
        }

        var nodes = new JsonObject();
        foreach (var (id, job) in plan.Jobs)
        {
            var dependsOnArr = new JsonArray();
            foreach (string d in job.DependsOn)
            {
                dependsOnArr.Add(d);
            }

            var dependedOnBy = new JsonArray();
            foreach (var (otherId, other) in plan.Jobs)
            {
                if (other.DependsOn.Contains(id))
                {
                    dependedOnBy.Add(otherId);
                }
            }

            nodes[id] = new JsonObject
            {
                ["dependsOn"] = dependsOnArr,
                ["dependedOnBy"] = dependedOnBy,
            };
        }

        return new JsonObject
        {
            ["success"] = true,
            ["plan_id"] = plan.Id,
            ["mermaid"] = sb.ToString(),
            ["nodes"] = nodes,
        };
    }

    /// <summary>Parses a <see cref="JobNode"/> from JSON parameters.</summary>
    protected static JobNode ParseJobNode(JsonElement parameters)
    {
        string producerId = parameters.GetProperty("producerId").GetString()!;
        string task = parameters.TryGetProperty("task", out var t) ? t.GetString() ?? string.Empty : string.Empty;
        string? instructions = parameters.TryGetProperty("instructions", out var inst) ? inst.GetString() : null;

        var deps = new List<string>();
        if (parameters.TryGetProperty("dependencies", out var depsEl) && depsEl.ValueKind == JsonValueKind.Array)
        {
            foreach (var d in depsEl.EnumerateArray())
            {
                string? val = d.GetString();
                if (val is not null)
                {
                    deps.Add(val);
                }
            }
        }

        return new JobNode
        {
            Id = producerId,
            Title = task,
            Status = JobStatus.Pending,
            DependsOn = deps,
            WorkSpec = instructions is not null ? new WorkSpec { Instructions = instructions } : null,
        };
    }

    /// <summary>Helper: placeholder response shared by tools until the daemon RPC client is wired in.</summary>
    protected ValueTask<JsonNode> StubResponseAsync() => ValueTask.FromResult<JsonNode>(new JsonObject
    {
        ["success"] = true,
        ["tool"] = this.Name,
        ["status"] = "pending-daemon",
    });
}
