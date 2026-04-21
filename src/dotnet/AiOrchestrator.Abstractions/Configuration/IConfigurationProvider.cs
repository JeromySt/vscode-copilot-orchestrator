// <copyright file="IConfigurationProvider.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Abstractions.Configuration;

/// <summary>
/// Provides typed access to configuration sections, with change notifications.
/// Independent of <c>Microsoft.Extensions.Configuration</c> (host concern).
/// </summary>
public interface IConfigurationProvider
{
    /// <summary>Reads the current bound value of the named configuration section.</summary>
    /// <typeparam name="T">The strongly-typed options shape for the section.</typeparam>
    /// <param name="section">The section name.</param>
    /// <returns>The current bound value.</returns>
    T Get<T>(string section)
        where T : class, new();

    /// <summary>Subscribes to changes in the named configuration section.</summary>
    /// <typeparam name="T">The strongly-typed options shape for the section.</typeparam>
    /// <param name="section">The section name.</param>
    /// <param name="handler">Invoked with the new value whenever the section changes.</param>
    /// <returns>An <see cref="IDisposable"/> that unsubscribes when disposed.</returns>
    IDisposable OnChange<T>(string section, Action<T> handler)
        where T : class, new();
}
