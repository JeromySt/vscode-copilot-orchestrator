// <copyright file="JsonRpcErrorDto.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;
using System.Text.Json.Serialization;

namespace AiOrchestrator.Mcp;

/// <summary>Wire-format DTO used by the source-generated serializer for error objects.</summary>
internal sealed class JsonRpcErrorDto
{
    /// <summary>Gets or sets the JSON-RPC error code.</summary>
    [JsonPropertyName("code")]
    public int Code { get; set; }

    /// <summary>Gets or sets the error message.</summary>
    [JsonPropertyName("message")]
    public string Message { get; set; } = string.Empty;

    /// <summary>Gets or sets optional additional error data.</summary>
    [JsonPropertyName("data")]
    public JsonElement? Data { get; set; }
}
