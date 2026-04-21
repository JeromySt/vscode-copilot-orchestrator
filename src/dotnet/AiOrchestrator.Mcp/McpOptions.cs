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
}
