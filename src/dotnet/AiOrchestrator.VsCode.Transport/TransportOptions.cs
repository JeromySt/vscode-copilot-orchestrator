// <copyright file="TransportOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.VsCode.Transport;

/// <summary>
/// Bindable options for the VS Code transport (job 040). Configured via
/// <see cref="Microsoft.Extensions.Options.IOptionsMonitor{T}"/> under the
/// <c>VsCodeTransport</c> configuration section.
/// </summary>
public sealed record TransportOptions
{
    /// <summary>
    /// Gets the idle timeout after which a <see cref="TransportSession"/> with no tool
    /// invocations is automatically disposed (INV-3). Default: 30 minutes.
    /// </summary>
    public TimeSpan SessionIdleTimeout { get; init; } = TimeSpan.FromMinutes(30);

    /// <summary>
    /// Gets a value indicating whether orchestrator events are translated into
    /// VS Code progress notifications via the MCP <c>progress</c> method (INV-6).
    /// Default: <see langword="true"/>.
    /// </summary>
    public bool EnableProgressNotifications { get; init; } = true;
}
