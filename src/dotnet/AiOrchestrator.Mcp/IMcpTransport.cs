// <copyright file="IMcpTransport.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Mcp;

/// <summary>
/// Abstraction over the underlying stream that carries JSON-RPC envelopes between the
/// MCP server and its single connected peer.
/// </summary>
public interface IMcpTransport
{
    /// <summary>Reads the next envelope from the peer. Returns <c>null</c> on EOF.</summary>
    /// <param name="ct">The cancellation token.</param>
    /// <returns>The decoded envelope or <c>null</c> if the stream has closed.</returns>
    ValueTask<JsonRpcEnvelope?> ReceiveAsync(CancellationToken ct);

    /// <summary>Writes an envelope to the peer.</summary>
    /// <param name="envelope">The envelope to send.</param>
    /// <param name="ct">The cancellation token.</param>
    /// <returns>A task that completes once the envelope has been flushed.</returns>
    ValueTask SendAsync(JsonRpcEnvelope envelope, CancellationToken ct);
}
