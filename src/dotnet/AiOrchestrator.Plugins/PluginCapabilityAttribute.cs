// <copyright file="PluginCapabilityAttribute.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Plugins;

/// <summary>
/// Applied to plugin implementation classes to declare which host capabilities the plugin requires.
/// The <see cref="PluginLoader"/> will record these at load time (INV-7); the <c>CapabilityChecker</c>
/// will refuse any undeclared capability at a call site.
/// </summary>
[AttributeUsage(AttributeTargets.Class, AllowMultiple = true)]
public sealed class PluginCapabilityAttribute : Attribute
{
    /// <summary>Initializes a new instance of the <see cref="PluginCapabilityAttribute"/> class.</summary>
    /// <param name="capability">The capability that the decorated class requires.</param>
    public PluginCapabilityAttribute(PluginCapability capability)
    {
        this.Capability = capability;
    }

    /// <summary>Gets the capability that the decorated class requires.</summary>
    public PluginCapability Capability { get; }
}
