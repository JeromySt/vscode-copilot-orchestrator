// <copyright file="McpJsonContext.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json.Serialization;

namespace AiOrchestrator.Mcp;

/// <summary>
/// Source-generated <see cref="JsonSerializerContext"/> for all MCP wire types.
/// All JSON serialization in the MCP server must route through this context so that
/// reflection-based serialization is never required at runtime.
/// </summary>
[JsonSerializable(typeof(JsonRpcEnvelopeDto))]
[JsonSerializable(typeof(JsonRpcErrorDto))]
[JsonSerializable(typeof(ToolListResponse))]
[JsonSerializable(typeof(ToolDescriptor))]
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
internal sealed partial class McpJsonContext : JsonSerializerContext
{
}
