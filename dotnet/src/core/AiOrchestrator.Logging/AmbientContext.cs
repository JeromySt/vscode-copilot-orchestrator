// <copyright file="AmbientContext.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace AiOrchestrator.Logging;

/// <summary>
/// Provides a thread-safe, async-flow-aware ambient correlation context stored in
/// <see cref="AsyncLocal{T}"/>. Pushing a key/value returns an <see cref="IDisposable"/>
/// that atomically restores the prior snapshot when disposed.
/// </summary>
public static class AmbientContext
{
    private static readonly AsyncLocal<ImmutableDictionary<string, object>> Current = new();

    /// <summary>
    /// Pushes a key/value pair into the ambient context for the current execution context.
    /// Disposing the returned scope restores the prior snapshot atomically.
    /// </summary>
    /// <param name="key">The context key.</param>
    /// <param name="value">The context value.</param>
    /// <returns>A disposable that restores the ambient context to its prior state.</returns>
    public static IDisposable Push(string key, object value)
    {
        var prior = Current.Value ?? ImmutableDictionary<string, object>.Empty;
        Current.Value = prior.SetItem(key, value);
        return new Restorer(prior);
    }

    /// <summary>Returns an immutable snapshot of the current ambient context.</summary>
    /// <returns>The current ambient key/value pairs.</returns>
    public static IReadOnlyDictionary<string, object> Snapshot()
        => Current.Value ?? ImmutableDictionary<string, object>.Empty;

    /// <summary>
    /// Gets a typed value from the ambient context for the given key,
    /// or <c>default</c> if the key is absent or the value cannot be cast.
    /// </summary>
    /// <typeparam name="T">The expected type of the value.</typeparam>
    /// <param name="key">The context key.</param>
    /// <returns>The typed value, or <c>default</c>.</returns>
    public static T? Get<T>(string key)
    {
        var dict = Current.Value;
        if (dict is null)
        {
            return default;
        }

        return dict.TryGetValue(key, out var val) && val is T typed ? typed : default;
    }

    private sealed class Restorer : IDisposable
    {
        private readonly ImmutableDictionary<string, object> snapshot;
        private bool disposed;

        internal Restorer(ImmutableDictionary<string, object> prior)
        {
            this.snapshot = prior;
        }

        public void Dispose()
        {
            if (this.disposed)
            {
                return;
            }

            this.disposed = true;
            Current.Value = this.snapshot;
        }
    }
}
