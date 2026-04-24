// <copyright file="PlanToolBase.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Mcp.Tools.Plan;

/// <summary>
/// Base class shared by the plan/job MCP tools. Each concrete tool sets its immutable
/// identity (name/description/schema) and overrides <see cref="InvokeCoreAsync"/> to
/// perform the tool-specific work by delegating to the daemon RPC client.
/// </summary>
internal abstract class PlanToolBase : IMcpTool
{
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

    /// <inheritdoc/>
    public ValueTask<JsonNode> InvokeAsync(JsonElement parameters, CancellationToken ct) =>
        this.InvokeCoreAsync(parameters, ct);

    /// <summary>Helper: builds an object schema with the specified required string properties.</summary>
    protected static JsonNode ObjectSchema(params string[] requiredStringProps)
    {
        var props = new JsonObject();
        var required = new JsonArray();
        foreach (string p in requiredStringProps)
        {
            props[p] = new JsonObject { ["type"] = "string" };
            required.Add(p);
        }

        return new JsonObject
        {
            ["type"] = "object",
            ["properties"] = props,
            ["required"] = required,
            ["additionalProperties"] = true,
        };
    }

    protected abstract ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct);

    /// <summary>Helper: placeholder response shared by tools until the daemon RPC client is wired in.</summary>
    protected ValueTask<JsonNode> StubResponseAsync() => ValueTask.FromResult<JsonNode>(new JsonObject
    {
        ["success"] = true,
        ["tool"] = this.Name,
        ["status"] = "pending-daemon",
    });
}
