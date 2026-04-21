// <copyright file="JsonRpcError.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;

namespace AiOrchestrator.Mcp;

/// <summary>JSON-RPC 2.0 structured error object.</summary>
public sealed record JsonRpcError
{
    /// <summary>Gets the numeric error code.</summary>
    public required int Code { get; init; }

    /// <summary>Gets the short human-readable error message.</summary>
    public required string Message { get; init; }

    /// <summary>Gets an optional data payload accompanying the error.</summary>
    public required JsonElement? Data { get; init; }
}
