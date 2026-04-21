// <copyright file="PluginUnverifiedLoadAllowed.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Plugins.Events;

/// <summary>
/// Published on every plugin load when <see cref="PluginOptions.RequireTrustFile"/> is
/// <see langword="false"/> (INV-10).  This is a development-only mode; receiving this event
/// in production indicates a misconfiguration.
/// </summary>
public sealed record PluginUnverifiedLoadAllowed
{
    /// <summary>Gets the plugin identifier that was loaded without trust verification.</summary>
    public required string PluginId { get; init; }

    /// <summary>Gets the UTC timestamp when the unverified load occurred.</summary>
    public required DateTimeOffset LoadedAt { get; init; }
}
