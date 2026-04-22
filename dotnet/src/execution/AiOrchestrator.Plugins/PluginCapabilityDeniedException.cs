// <copyright file="PluginCapabilityDeniedException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Plugins;

/// <summary>
/// Thrown by <see cref="Capability.CapabilityChecker.EnforceAtCallSiteAsync"/> when a
/// plugin attempts to use a host capability it has not declared in its
/// <see cref="PluginCapabilityAttribute"/> attributes.
/// </summary>
public sealed class PluginCapabilityDeniedException : Exception
{
    /// <summary>Initializes a new instance of the <see cref="PluginCapabilityDeniedException"/> class.</summary>
    public PluginCapabilityDeniedException()
    {
    }

    /// <summary>Initializes a new instance of the <see cref="PluginCapabilityDeniedException"/> class.</summary>
    /// <param name="message">The exception message.</param>
    public PluginCapabilityDeniedException(string message)
        : base(message)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="PluginCapabilityDeniedException"/> class.</summary>
    /// <param name="message">The exception message.</param>
    /// <param name="innerException">The inner exception.</param>
    public PluginCapabilityDeniedException(string message, Exception innerException)
        : base(message, innerException)
    {
    }

    /// <summary>Gets the identifier of the plugin that was denied.</summary>
    public required string PluginId { get; init; }

    /// <summary>Gets the capability that was requested but not declared.</summary>
    public required PluginCapability Required { get; init; }
}
