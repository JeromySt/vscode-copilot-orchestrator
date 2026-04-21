// <copyright file="IWorktreeLease.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.WorktreeLease;

/// <summary>
/// Provides exclusive, monotonically-fenced acquisition of a git worktree (§3.31.2.1).
/// Acquisition is CAS-under-lock on <c>&lt;worktree&gt;/.aio/lease.json</c> (LS-CAS-*).
/// </summary>
public interface IWorktreeLease
{
    /// <summary>Acquires an exclusive lease on <paramref name="worktree"/> for <paramref name="holder"/>.</summary>
    /// <param name="worktree">Absolute path to the worktree root.</param>
    /// <param name="holder">The authenticated principal that will hold the lease.</param>
    /// <param name="ttl">Initial time-to-live for the lease.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="LeaseHandle"/> owning the acquired lease.</returns>
    ValueTask<LeaseHandle> AcquireAsync(AbsolutePath worktree, AuthContext holder, TimeSpan ttl, CancellationToken ct);

    /// <summary>Renews <paramref name="handle"/>, extending <c>ExpiresAt</c> and incrementing the fencing token (INV-9).</summary>
    /// <param name="handle">The lease handle to renew.</param>
    /// <param name="ttl">The new time-to-live, measured from now.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when the lease file has been updated.</returns>
    ValueTask RenewAsync(LeaseHandle handle, TimeSpan ttl, CancellationToken ct);

    /// <summary>Releases the lease represented by <paramref name="handle"/> (deletes the lease file).</summary>
    /// <param name="handle">The lease handle to release.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when the lease has been released.</returns>
    ValueTask ReleaseAsync(LeaseHandle handle, CancellationToken ct);

    /// <summary>Reads a read-only snapshot of the current lease on <paramref name="worktree"/>, or <see langword="null"/> if none exists.</summary>
    /// <param name="worktree">Absolute path to the worktree root.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The parsed <see cref="LeaseInfo"/>, or <see langword="null"/> if the lease file is absent.</returns>
    ValueTask<LeaseInfo?> InspectAsync(AbsolutePath worktree, CancellationToken ct);
}
