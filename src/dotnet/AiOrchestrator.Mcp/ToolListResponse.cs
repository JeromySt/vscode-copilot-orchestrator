// <copyright file="ToolListResponse.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Text.Json.Serialization;

namespace AiOrchestrator.Mcp;

/// <summary>Response DTO for the <c>tools/list</c> RPC.</summary>
internal sealed class ToolListResponse
{
    [JsonPropertyName("tools")]
    public ToolDescriptor[] Tools { get; set; } = Array.Empty<ToolDescriptor>();
}
