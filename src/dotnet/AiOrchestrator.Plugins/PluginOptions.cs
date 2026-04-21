// <copyright file="PluginOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Plugins;

/// <summary>
/// Configuration options for the <see cref="PluginLoader"/>. Bind from the <c>Plugins</c>
/// configuration section via <c>IOptionsMonitor&lt;PluginOptions&gt;</c>.
/// </summary>
public sealed record PluginOptions
{
    /// <summary>Gets the root directory under which plugin subdirectories are discovered.</summary>
    public required AbsolutePath PluginRoot { get; init; }

    /// <summary>Gets the absolute path to the trust file that gates which plugins may be loaded.</summary>
    public required AbsolutePath TrustFilePath { get; init; }

    /// <summary>
    /// Gets a value indicating whether a valid trust file is required before loading any plugin.
    /// When <see langword="false"/>, an <c>PluginUnverifiedLoadAllowed</c> warning audit event is
    /// emitted on every load.  Allowed only for development environments.
    /// </summary>
    public bool RequireTrustFile { get; init; } = true;

    /// <summary>
    /// Gets the version of the host assembly used for <c>MinHostVersion</c>/<c>MaxHostVersion</c>
    /// compatibility checks (INV-5).  Defaults to the version of the <see cref="PluginLoader"/> assembly.
    /// </summary>
    public Version HostVersion { get; init; } = typeof(PluginLoader).Assembly.GetName().Version!;

    /// <summary>
    /// Gets the raw bytes of the Ed25519 public key used to verify the trust file signature (INV-2).
    /// Must be exactly 32 bytes.  Required when <see cref="RequireTrustFile"/> is <see langword="true"/>.
    /// </summary>
    public byte[] TrustFileSignerPublicKey { get; init; } = [];
}
