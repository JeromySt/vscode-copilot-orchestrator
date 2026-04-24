// <copyright file="FramingCodec.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AiOrchestrator.Mcp.Transports;

/// <summary>Encodes/decodes <see cref="JsonRpcEnvelope"/> values from UTF-8 byte payloads.</summary>
internal static class FramingCodec
{
    /// <summary>Encodes a <see cref="JsonRpcEnvelope"/> into a UTF-8 JSON byte array.</summary>
    public static byte[] Encode(JsonRpcEnvelope env)
    {
        var dto = new JsonRpcEnvelopeDto
        {
            JsonRpc = env.JsonRpc,
            Method = env.Method,
            Params = env.Params,
            Result = env.Result is { } r ? JsonNode.Parse(r.GetRawText()) : null,
            Error = env.Error is null ? null : new JsonRpcErrorDto
            {
                Code = env.Error.Code,
                Message = env.Error.Message,
                Data = env.Error.Data,
            },
            Id = env.Id switch
            {
                null => null,
                JsonElement je => je,
                _ => JsonSerializer.SerializeToElement(env.Id, env.Id.GetType(), McpJsonContext.Default),
            },
        };

        return JsonSerializer.SerializeToUtf8Bytes(dto, typeof(JsonRpcEnvelopeDto), McpJsonContext.Default);
    }

    /// <summary>Decodes a UTF-8 JSON byte span into a <see cref="JsonRpcEnvelope"/>.</summary>
    public static JsonRpcEnvelope? Decode(ReadOnlySpan<byte> utf8)
    {
        var reader = new Utf8JsonReader(utf8, new JsonReaderOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip });
        var dto = (JsonRpcEnvelopeDto?)JsonSerializer.Deserialize(ref reader, typeof(JsonRpcEnvelopeDto), McpJsonContext.Default);
        if (dto is null)
        {
            return null;
        }

        return new JsonRpcEnvelope
        {
            JsonRpc = dto.JsonRpc ?? string.Empty,
            Method = dto.Method,
            Params = dto.Params,
            Result = dto.Result is null ? null : JsonSerializer.SerializeToElement(dto.Result, typeof(JsonNode), McpJsonContext.Default),
            Error = dto.Error is null ? null : new JsonRpcError { Code = dto.Error.Code, Message = dto.Error.Message, Data = dto.Error.Data },
            Id = dto.Id is { ValueKind: not JsonValueKind.Undefined } id ? id : null,
        };
    }
}
