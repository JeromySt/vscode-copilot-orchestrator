// <copyright file="AiOrchestratorOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.IO;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Hosting;

/// <summary>
/// Options for bootstrapping the AiOrchestrator service composition.
/// </summary>
public sealed record AiOrchestratorOptions
{
    /// <summary>Gets the root directory used by the plan store.</summary>
    public AbsolutePath StoreRoot { get; init; } = new AbsolutePath(
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ai-orchestrator"));

    /// <summary>Gets a value indicating whether the HookGate authorization gate is enabled.</summary>
    public bool EnableHookGate { get; init; } = true;

    /// <summary>Gets a value indicating whether the ConcurrencyBroker service is enabled.</summary>
    public bool EnableConcurrencyBroker { get; init; } = true;

    /// <summary>Gets a value indicating whether the plugin loader daemon is enabled.</summary>
    public bool EnablePluginLoader { get; init; } = true;

    /// <summary>Gets a value indicating whether OTLP telemetry export is enabled.</summary>
    public bool EnableTelemetry { get; init; }
}
