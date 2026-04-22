// <copyright file="LeaseHandle.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.WorktreeLease;

/// <summary>
/// Owning handle to an acquired worktree lease. Disposing the handle releases the lease.
/// </summary>
/// <remarks>Disposal is idempotent (INV-7).</remarks>
public sealed class LeaseHandle : IAsyncDisposable
{
    private readonly Func<LeaseHandle, CancellationToken, ValueTask>? releaseCallback;
    private int disposed;

    /// <summary>Initializes a new instance of the <see cref="LeaseHandle"/> class without a release callback.</summary>
    /// <remarks>Used by tests and by the <see cref="IWorktreeLease.InspectAsync"/> path which returns a non-owning handle.</remarks>
    public LeaseHandle()
    {
    }

    internal LeaseHandle(Func<LeaseHandle, CancellationToken, ValueTask> releaseCallback)
    {
        this.releaseCallback = releaseCallback;
    }

    /// <summary>Gets the fencing token of the held lease.</summary>
    public required FencingToken Token { get; init; }

    /// <summary>Gets the worktree absolute path.</summary>
    public required AbsolutePath Worktree { get; init; }

    /// <summary>Gets the principal that holds the lease.</summary>
    public required AuthContext Holder { get; init; }

    /// <summary>Gets the UTC time at which the lease expires unless renewed.</summary>
    public required DateTimeOffset ExpiresAt { get; init; }

    /// <summary>Gets a value indicating whether this handle has been disposed/released.</summary>
    public bool IsDisposed => Volatile.Read(ref this.disposed) != 0;

    /// <inheritdoc/>
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref this.disposed, 1) != 0)
        {
            return; // INV-7 idempotent
        }

        if (this.releaseCallback is not null)
        {
            await this.releaseCallback(this, CancellationToken.None).ConfigureAwait(false);
        }
    }

    internal void MarkDisposed() => Interlocked.Exchange(ref this.disposed, 1);
}
