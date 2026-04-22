// <copyright file="LoadedPlugin.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Abstractions.Plugins;

/// <summary>Represents a plugin assembly that has been loaded into an isolated context.</summary>
public sealed record LoadedPlugin
{
    /// <summary>Gets the unique identifier of the plugin (typically the assembly name).</summary>
    public required string Id { get; init; }

    /// <summary>Gets the plugin's reported version string.</summary>
    public required string Version { get; init; }

    /// <summary>Gets the absolute path on disk to the plugin's primary assembly.</summary>
    public required AbsolutePath AssemblyPath { get; init; }

    /// <summary>Gets the SHA-256 hash of the plugin assembly bytes, lowercase hex.</summary>
    public required string AssemblySha256 { get; init; }
}
