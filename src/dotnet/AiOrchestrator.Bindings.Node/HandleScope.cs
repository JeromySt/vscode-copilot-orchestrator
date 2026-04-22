// <copyright file="HandleScope.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Bindings.Node;

/// <summary>
/// Bounds the lifetime of a set of <see cref="HandleId"/>s. When the scope is
/// disposed, every handle registered through <see cref="RegisterAsync{T}"/> is
/// released back to the host and subsequent <see cref="NodeBindingsHost.ResolveHandleAsync{T}"/>
/// calls for those handles will raise <see cref="HandleDisposedException"/>.
/// </summary>
public sealed class HandleScope : IAsyncDisposable
{
    private readonly NodeBindingsHost host;
    private readonly List<HandleId> registered = new();
    private readonly object sync = new();
    private int disposed;

    /// <summary>Initializes a new instance of the <see cref="HandleScope"/> class.</summary>
    /// <param name="host">The host responsible for the underlying handle table.</param>
    public HandleScope(NodeBindingsHost host)
    {
        ArgumentNullException.ThrowIfNull(host);
        this.host = host;
    }

    /// <summary>Registers <paramref name="instance"/> for the duration of this scope.</summary>
    /// <typeparam name="T">The reference type of the instance.</typeparam>
    /// <param name="instance">The .NET object to expose.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="HandleId"/> valid until this scope is disposed.</returns>
    public ValueTask<HandleId> RegisterAsync<T>(T instance, CancellationToken ct)
        where T : class
    {
        ArgumentNullException.ThrowIfNull(instance);
        this.ThrowIfDisposed();
        ct.ThrowIfCancellationRequested();

        HandleId id = this.host.RegisterInternal(instance);
        lock (this.sync)
        {
            this.registered.Add(id);
        }

        return new ValueTask<HandleId>(id);
    }

    /// <inheritdoc/>
    public ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref this.disposed, 1) != 0)
        {
            return ValueTask.CompletedTask;
        }

        HandleId[] snapshot;
        lock (this.sync)
        {
            snapshot = this.registered.ToArray();
            this.registered.Clear();
        }

        foreach (HandleId id in snapshot)
        {
            this.host.RemoveHandle(id);
        }

        return ValueTask.CompletedTask;
    }

    private void ThrowIfDisposed()
    {
        if (Volatile.Read(ref this.disposed) != 0)
        {
            throw new ObjectDisposedException(nameof(HandleScope));
        }
    }
}
