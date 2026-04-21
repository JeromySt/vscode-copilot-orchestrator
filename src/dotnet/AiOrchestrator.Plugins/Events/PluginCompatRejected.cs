// <copyright file="PluginCompatRejected.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Plugins.Events;

/// <summary>
/// Published when a plugin's <c>MinHostVersion</c>/<c>MaxHostVersion</c> range does not include
/// the current host version (INV-5).
/// </summary>
public sealed record PluginCompatRejected
{
    /// <summary>Gets the unique identifier of the rejected plugin.</summary>
    public required string PluginId { get; init; }

    /// <summary>Gets the plugin version declared in its manifest.</summary>
    public required string PluginVersion { get; init; }

    /// <summary>Gets the minimum host version the plugin requires.</summary>
    public required string MinHostVersion { get; init; }

    /// <summary>Gets the maximum host version the plugin supports.</summary>
    public required string MaxHostVersion { get; init; }

    /// <summary>Gets the current host version that was compared against the plugin's range.</summary>
    public required string ActualHostVersion { get; init; }

    /// <summary>Gets the UTC timestamp when the compatibility check was performed.</summary>
    public required DateTimeOffset RejectedAt { get; init; }
}
