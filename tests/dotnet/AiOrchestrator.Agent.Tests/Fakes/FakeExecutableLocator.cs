// <copyright file="FakeExecutableLocator.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Agent.Tests.Fakes;

/// <summary>Deterministic locator. Returns <c>/fake/bin/{name}</c> for names in <see cref="Installed"/>.</summary>
public sealed class FakeExecutableLocator : IExecutableLocator
{
    /// <summary>Gets the set of names considered installed.</summary>
    public HashSet<string> Installed { get; } = new(StringComparer.OrdinalIgnoreCase);

    /// <inheritdoc/>
    public string? Locate(string executableName)
    {
        return this.Installed.Contains(executableName)
            ? $"/fake/bin/{executableName}"
            : null;
    }
}
