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
    /// <summary>Gets or sets the JSON-RPC version string.</summary>
    [JsonPropertyName("jsonrpc")]
    public string? JsonRpc { get; set; }

    /// <summary>Gets or sets the RPC method name.</summary>
    [JsonPropertyName("method")]
    public string? Method { get; set; }

    /// <summary>Gets or sets the method parameters.</summary>
    [JsonPropertyName("params")]
    public JsonElement? Params { get; set; }

    /// <summary>Gets or sets the RPC result payload.</summary>
    [JsonPropertyName("result")]
    public JsonNode? Result { get; set; }

    /// <summary>Gets or sets the RPC error, if any.</summary>
    [JsonPropertyName("error")]
    public JsonRpcErrorDto? Error { get; set; }

    /// <summary>Gets or sets the request/response correlation identifier.</summary>
    [JsonPropertyName("id")]
    public JsonElement? Id { get; set; }
}
