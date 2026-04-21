// <copyright file="IMcpTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Mcp;

/// <summary>
/// Contract implemented by every MCP tool. Tools advertise a JSON-Schema describing their
/// parameters; the <see cref="McpToolRegistry"/> validates inputs before invocation.
/// </summary>
public interface IMcpTool
{
    /// <summary>Gets the stable, canonical tool name (e.g. <c>scaffold_copilot_plan</c>).</summary>
    string Name { get; }

    /// <summary>Gets the human-readable description shown to clients during tool discovery.</summary>
    string Description { get; }

    /// <summary>Gets the JSON-Schema (draft 2020-12) describing the tool's input parameters.</summary>
    JsonNode InputSchema { get; }

    /// <summary>Invokes the tool with the supplied parameters.</summary>
    /// <param name="parameters">The JSON parameters object supplied by the caller.</param>
    /// <param name="ct">A cancellation token propagated from the server.</param>
    /// <returns>A JSON result node that is returned to the caller verbatim.</returns>
    ValueTask<JsonNode> InvokeAsync(JsonElement parameters, CancellationToken ct);
}
