// <copyright file="JsonRpcEnvelope.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;

namespace AiOrchestrator.Mcp;

/// <summary>
/// A JSON-RPC 2.0 envelope. Either <see cref="Method"/> (request/notification) or one of
/// <see cref="Result"/> / <see cref="Error"/> (response) is populated.
/// </summary>
public sealed record JsonRpcEnvelope
{
    /// <summary>Gets the JSON-RPC protocol version. Must always be <c>"2.0"</c>.</summary>
    public required string JsonRpc { get; init; }

    /// <summary>Gets the method name for requests and notifications. <c>null</c> on responses.</summary>
    public required string? Method { get; init; }

    /// <summary>Gets the parameter payload for requests. <c>null</c> when absent.</summary>
    public required JsonElement? Params { get; init; }

    /// <summary>Gets the successful result payload for responses. <c>null</c> on requests or errors.</summary>
    public required JsonElement? Result { get; init; }

    /// <summary>Gets the error object on error responses. <c>null</c> otherwise.</summary>
    public required JsonRpcError? Error { get; init; }

    /// <summary>Gets the correlation identifier supplied by the client.</summary>
    public required object? Id { get; init; }
}
