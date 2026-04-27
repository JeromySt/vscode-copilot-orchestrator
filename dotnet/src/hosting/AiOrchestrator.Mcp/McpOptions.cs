// <copyright file="McpOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Mcp;

/// <summary>
/// Configuration options for the <see cref="McpServer"/>.
/// </summary>
public sealed record McpOptions
{
    /// <summary>Gets the transport used to frame JSON-RPC messages. Defaults to <see cref="McpTransportKind.Stdio"/>.</summary>
    public McpTransportKind Transport { get; init; } = McpTransportKind.Stdio;

    /// <summary>Gets the per-invocation timeout applied to every tool. Defaults to 60 seconds.</summary>
    public TimeSpan ToolInvokeTimeout { get; init; } = TimeSpan.FromSeconds(60);

    /// <summary>
    /// Gets the auth nonce that clients must present in the <c>initialize</c> handshake
    /// (<c>clientInfo.nonce</c>). When non-null, the server rejects <c>initialize</c>
    /// requests that don't include a matching nonce — binding the daemon to the specific
    /// process that spawned it. When <c>null</c> (e.g. system-wide service mode),
    /// nonce validation is skipped and only OS-level peer credentials are checked.
    /// </summary>
    public string? AuthNonce { get; init; }
}
