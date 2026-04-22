// <copyright file="PluginTrustFileInvalidPerms.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Plugins.Events;

/// <summary>
/// Published when the trust file exists but has broader than owner-only permissions (INV-1, TRUST-ACL-1).
/// This is a startup error that prevents any plugin from loading.
/// </summary>
public sealed record PluginTrustFileInvalidPerms
{
    /// <summary>Gets the absolute path to the trust file that failed the permissions check.</summary>
    public required string TrustFilePath { get; init; }

    /// <summary>Gets the UTC timestamp when the failure was detected.</summary>
    public required DateTimeOffset DetectedAt { get; init; }
}
