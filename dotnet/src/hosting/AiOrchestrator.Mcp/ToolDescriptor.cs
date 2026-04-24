// <copyright file="ToolDescriptor.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace AiOrchestrator.Mcp;

/// <summary>Per-tool descriptor included in <see cref="ToolListResponse"/>.</summary>
internal sealed class ToolDescriptor
{
    /// <summary>Gets or sets the tool name.</summary>
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    /// <summary>Gets or sets the human-readable tool description.</summary>
    [JsonPropertyName("description")]
    public string Description { get; set; } = string.Empty;

    /// <summary>Gets or sets the JSON Schema for the tool's input parameters.</summary>
    [JsonPropertyName("inputSchema")]
    public JsonNode? InputSchema { get; set; }
}
