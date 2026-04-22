// <copyright file="JsonRpcErrorDto.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;
using System.Text.Json.Serialization;

namespace AiOrchestrator.Mcp;

/// <summary>Wire-format DTO used by the source-generated serializer for error objects.</summary>
internal sealed class JsonRpcErrorDto
{
    [JsonPropertyName("code")]
    public int Code { get; set; }

    [JsonPropertyName("message")]
    public string Message { get; set; } = string.Empty;

    [JsonPropertyName("data")]
    public JsonElement? Data { get; set; }
}
