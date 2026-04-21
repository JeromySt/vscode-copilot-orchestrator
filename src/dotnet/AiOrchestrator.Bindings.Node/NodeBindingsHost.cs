// <copyright file="NodeBindingsHost.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Bindings.Node;

/// <summary>
/// Hosts the table of <see cref="HandleId"/> → .NET-object mappings exposed
/// to Node callers via N-API. Handles are always acquired through a
/// <see cref="HandleScope"/>; resolving a handle after its owning scope has
/// been disposed raises a <see cref="HandleDisposedException"/>.
/// </summary>
public sealed class NodeBindingsHost : IAsyncDisposable
{
    private readonly IServiceProvider services;
    private readonly ConcurrentDictionary<long, object> handles = new();
    private long nextHandle;
    private int disposed;

    /// <summary>Initializes a new instance of the <see cref="NodeBindingsHost"/> class.</summary>
    /// <param name="sp">The service provider used to resolve host-side services when bridging calls from Node.</param>
    public NodeBindingsHost(IServiceProvider sp)
    {
        ArgumentNullException.ThrowIfNull(sp);
        this.services = sp;
    }

    /// <summary>Gets the ambient service provider made available to bridged calls.</summary>
    internal IServiceProvider Services => this.services;

    /// <summary>
    /// Registers <paramref name="instance"/> in the host handle table and returns a
    /// scope-free <see cref="HandleId"/>. Prefer <see cref="HandleScope.RegisterAsync{T}"/>
    /// for lifetime-bounded registrations.
    /// </summary>
    /// <typeparam name="T">The reference type of the instance to register.</typeparam>
    /// <param name="instance">The .NET object to expose to Node.</param>
    /// <param name="ct">Cancellation token observed for graceful shutdown.</param>
    /// <returns>An opaque <see cref="HandleId"/> consumable by the Node side.</returns>
    public ValueTask<HandleId> CreateHandleAsync<T>(T instance, CancellationToken ct)
        where T : class
    {
        ArgumentNullException.ThrowIfNull(instance);
        this.ThrowIfDisposed();
        ct.ThrowIfCancellationRequested();

        long id = Interlocked.Increment(ref this.nextHandle);
        this.handles[id] = instance;
        return new ValueTask<HandleId>(new HandleId(id));
    }

    /// <summary>Resolves a previously-issued <see cref="HandleId"/> to its underlying instance.</summary>
    /// <typeparam name="T">The expected runtime type.</typeparam>
    /// <param name="handle">The handle to resolve.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The resolved instance.</returns>
    /// <exception cref="HandleDisposedException">Thrown when the handle has been disposed.</exception>
    public ValueTask<T> ResolveHandleAsync<T>(HandleId handle, CancellationToken ct)
        where T : class
    {
        this.ThrowIfDisposed();
        ct.ThrowIfCancellationRequested();

        if (!this.handles.TryGetValue(handle.Value, out object? value))
        {
            throw new HandleDisposedException();
        }

        return new ValueTask<T>((T)value);
    }

    /// <summary>Releases the handle and removes the underlying mapping from the host table.</summary>
    /// <param name="handle">The handle to dispose.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A task that completes once the handle has been removed.</returns>
    public ValueTask DisposeHandleAsync(HandleId handle, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        _ = this.handles.TryRemove(handle.Value, out _);
        return ValueTask.CompletedTask;
    }

    /// <inheritdoc/>
    public ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref this.disposed, 1) != 0)
        {
            return ValueTask.CompletedTask;
        }

        this.handles.Clear();
        return ValueTask.CompletedTask;
    }

    internal bool TryResolve(HandleId handle, out object? value)
    {
        return this.handles.TryGetValue(handle.Value, out value);
    }

    internal void RemoveHandle(HandleId handle)
    {
        _ = this.handles.TryRemove(handle.Value, out _);
    }

    internal HandleId RegisterInternal(object instance)
    {
        long id = Interlocked.Increment(ref this.nextHandle);
        this.handles[id] = instance;
        return new HandleId(id);
    }

    private void ThrowIfDisposed()
    {
        if (Volatile.Read(ref this.disposed) != 0)
        {
            throw new ObjectDisposedException(nameof(NodeBindingsHost));
        }
    }
}
