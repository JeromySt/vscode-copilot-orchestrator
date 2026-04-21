// <copyright file="McpToolRegistry.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Mcp;

/// <summary>
/// Holds the set of registered <see cref="IMcpTool"/> instances and performs
/// schema validation + cancellation plumbing around every invocation.
/// </summary>
public sealed class McpToolRegistry
{
    private readonly Dictionary<string, IMcpTool> tools;

    /// <summary>Initializes a new instance of the <see cref="McpToolRegistry"/> class.</summary>
    /// <param name="tools">The tool instances to register.</param>
    /// <exception cref="InvalidOperationException">Thrown when two tools share a name.</exception>
    public McpToolRegistry(IEnumerable<IMcpTool> tools)
    {
        ArgumentNullException.ThrowIfNull(tools);

        this.tools = new Dictionary<string, IMcpTool>(StringComparer.Ordinal);
        foreach (IMcpTool tool in tools)
        {
            if (this.tools.ContainsKey(tool.Name))
            {
                throw new InvalidOperationException($"Duplicate MCP tool name registered: '{tool.Name}'.");
            }

            this.tools.Add(tool.Name, tool);
        }
    }

    /// <summary>Gets the registered tools keyed by name.</summary>
    public IReadOnlyDictionary<string, IMcpTool> Tools => this.tools;

    /// <summary>Validates parameters against the tool's schema and invokes it.</summary>
    /// <param name="toolName">The name of the tool to invoke.</param>
    /// <param name="parameters">The JSON parameters supplied by the caller.</param>
    /// <param name="ct">The cancellation token.</param>
    /// <returns>The tool's JSON result.</returns>
    /// <exception cref="KeyNotFoundException">Thrown when <paramref name="toolName"/> is unknown.</exception>
    /// <exception cref="McpInvalidParamsException">Thrown when the parameters fail schema validation.</exception>
    public ValueTask<JsonNode> InvokeAsync(string toolName, JsonElement parameters, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(toolName);

        if (!this.tools.TryGetValue(toolName, out IMcpTool? tool))
        {
            throw new KeyNotFoundException($"Unknown tool: '{toolName}'.");
        }

        IReadOnlyList<string> errors = JsonSchemaValidator.Validate(tool.InputSchema, parameters);
        if (errors.Count > 0)
        {
            throw new McpInvalidParamsException(string.Join("; ", errors));
        }

        return tool.InvokeAsync(parameters, ct);
    }
}
