// <copyright file="PluginRejected.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Plugins.Events;

/// <summary>Published when a discovered plugin is rejected for any reason (trust, hash, version, manifest) (INV-9).</summary>
public sealed record PluginRejected
{
    /// <summary>Gets the plugin identifier, if it could be determined from the manifest.</summary>
    public required string PluginId { get; init; }

    /// <summary>Gets the SHA-256 hex digest of the assembly that was rejected (empty if not computable).</summary>
    public required string AssemblySha256 { get; init; }

    /// <summary>Gets a human-readable reason for the rejection.</summary>
    public required string Reason { get; init; }

    /// <summary>Gets the UTC timestamp of the rejection.</summary>
    public required DateTimeOffset RejectedAt { get; init; }
}
