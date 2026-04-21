// <copyright file="IExecutableLocator.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Agent;

/// <summary>Locates an executable on the host <c>PATH</c>. Stubbable for tests (INV-12).</summary>
public interface IExecutableLocator
{
    /// <summary>Resolves an executable name to its absolute path, or null when not installed.</summary>
    /// <param name="executableName">Executable basename (e.g. <c>claude</c>, <c>gh</c>).</param>
    /// <returns>The absolute path, or null.</returns>
    string? Locate(string executableName);
}
