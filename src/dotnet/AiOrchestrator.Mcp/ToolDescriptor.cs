// <copyright file="ToolDescriptor.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace AiOrchestrator.Mcp;

/// <summary>Per-tool descriptor included in <see cref="ToolListResponse"/>.</summary>
internal sealed class ToolDescriptor
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("description")]
    public string Description { get; set; } = string.Empty;

    [JsonPropertyName("inputSchema")]
    public JsonNode? InputSchema { get; set; }
}
