// <copyright file="LayeredConfigurationProvider.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Configuration;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Primitives;

namespace AiOrchestrator.Configuration;

/// <summary>
/// Implements <see cref="AiOrchestrator.Abstractions.Configuration.IConfigurationProvider" /> by layering
/// <see cref="IConfiguration" /> sources according to INV-1 precedence order.
/// Bound values are immutable snapshots; callers subscribe via
/// <see cref="OnChange{T}" /> to receive updated snapshots on reload.
/// </summary>
public sealed class LayeredConfigurationProvider : AiOrchestrator.Abstractions.Configuration.IConfigurationProvider
{
    private readonly IConfiguration _root;

    /// <summary>Initializes a new instance of the <see cref="LayeredConfigurationProvider"/> class.</summary>
    /// <param name="root">
    /// The fully layered <see cref="IConfiguration" /> produced by the host builder
    /// (defaults → appsettings.json → appsettings.{env}.json → env vars → CLI → in-memory).
    /// </param>
    public LayeredConfigurationProvider(IConfiguration root)
    {
        this._root = root ?? throw new ArgumentNullException(nameof(root));
    }

    /// <inheritdoc />
    public T Get<T>(string section)
        where T : class, new()
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(section);
        return this._root.GetSection(section).Get<T>() ?? new T();
    }

    /// <inheritdoc />
    public IDisposable OnChange<T>(string section, Action<T> handler)
        where T : class, new()
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(section);
        ArgumentNullException.ThrowIfNull(handler);

        return ChangeToken.OnChange(
            () => this._root.GetReloadToken(),
            () => handler(this.Get<T>(section)));
    }
}
