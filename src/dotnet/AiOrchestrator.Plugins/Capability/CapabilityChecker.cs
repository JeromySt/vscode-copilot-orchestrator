// <copyright file="CapabilityChecker.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Runtime.CompilerServices;

namespace AiOrchestrator.Plugins.Capability;

/// <summary>
/// Enforces capability declarations at host call sites (INV-8).
/// Host code that performs a capability-bound action (file write outside plugin sandbox,
/// process spawn, network call, credential read) MUST call
/// <see cref="EnforceAtCallSiteAsync"/> before proceeding.
/// </summary>
internal sealed class CapabilityChecker
{
    private readonly IReadOnlyDictionary<string, ImmutableArray<PluginCapability>> pluginCapabilities;

    /// <summary>
    /// Initializes a new instance of the <see cref="CapabilityChecker"/> class.
    /// </summary>
    /// <param name="pluginCapabilities">Map of plugin ID → declared capabilities.</param>
    public CapabilityChecker(IReadOnlyDictionary<string, ImmutableArray<PluginCapability>> pluginCapabilities)
    {
        this.pluginCapabilities = pluginCapabilities ?? throw new ArgumentNullException(nameof(pluginCapabilities));
    }

    /// <summary>
    /// Returns <see langword="true"/> if <paramref name="plugin"/> has declared
    /// <paramref name="capability"/> in its <see cref="PluginCapabilityAttribute"/> attributes.
    /// </summary>
    /// <param name="plugin">The loaded plugin to check.</param>
    /// <param name="capability">The capability to test.</param>
    /// <returns><see langword="true"/> if the capability is declared; otherwise <see langword="false"/>.</returns>
    public bool IsAllowed(LoadedPlugin plugin, PluginCapability capability)
    {
        ArgumentNullException.ThrowIfNull(plugin);
        return plugin.Capabilities.Contains(capability);
    }

    /// <summary>
    /// Asserts that the currently active plugin (identified by <paramref name="pluginId"/>) has
    /// declared <paramref name="required"/>.  Throws <see cref="PluginCapabilityDeniedException"/>
    /// if the capability is not declared.
    /// </summary>
    /// <param name="pluginId">The plugin identifier performing the action.</param>
    /// <param name="required">The capability being exercised.</param>
    /// <param name="caller">
    /// The host call-site member name; auto-populated by the compiler via
    /// <see cref="CallerMemberNameAttribute"/>.
    /// </param>
    /// <returns>A <see cref="ValueTask"/> that completes immediately after the check.</returns>
    /// <exception cref="PluginCapabilityDeniedException">Thrown when <paramref name="required"/> is not declared.</exception>
    public ValueTask EnforceAtCallSiteAsync(
        string pluginId,
        PluginCapability required,
        [CallerMemberName] string? caller = null)
    {
        ArgumentNullException.ThrowIfNull(pluginId);

        if (!this.pluginCapabilities.TryGetValue(pluginId, out var caps) || !caps.Contains(required))
        {
            throw new PluginCapabilityDeniedException(
                $"Plugin '{pluginId}' attempted to use capability '{required}' at call site '{caller}' but did not declare it.")
            {
                PluginId = pluginId,
                Required = required,
            };
        }

        return ValueTask.CompletedTask;
    }
}
