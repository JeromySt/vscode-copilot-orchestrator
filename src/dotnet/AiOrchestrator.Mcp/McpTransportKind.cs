// <copyright file="McpTransportKind.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Mcp;

/// <summary>The transport used by <see cref="McpServer"/> to exchange JSON-RPC envelopes.</summary>
public enum McpTransportKind
{
    /// <summary>Line-delimited JSON-RPC over process stdio (MCP default).</summary>
    Stdio = 0,

    /// <summary>JSON-RPC over a named pipe.</summary>
    NamedPipe = 1,

    /// <summary>JSON-RPC over a Unix domain socket.</summary>
    UnixSocket = 2,
}
