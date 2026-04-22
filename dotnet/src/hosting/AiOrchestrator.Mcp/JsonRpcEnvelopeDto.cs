// <copyright file="JsonRpcEnvelopeDto.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace AiOrchestrator.Mcp;

/// <summary>Wire-format DTO used by the source-generated serializer for envelopes.</summary>
internal sealed class JsonRpcEnvelopeDto
{
    [JsonPropertyName("jsonrpc")]
    public string? JsonRpc { get; set; }

    [JsonPropertyName("method")]
    public string? Method { get; set; }

    [JsonPropertyName("params")]
    public JsonElement? Params { get; set; }

    [JsonPropertyName("result")]
    public JsonNode? Result { get; set; }

    [JsonPropertyName("error")]
    public JsonRpcErrorDto? Error { get; set; }

    [JsonPropertyName("id")]
    public JsonElement? Id { get; set; }
}
