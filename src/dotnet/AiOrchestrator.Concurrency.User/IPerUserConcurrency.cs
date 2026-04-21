// <copyright file="IPerUserConcurrency.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Concurrency.User;

/// <summary>
/// Admits units of work per principal, enforcing per-user concurrency limits
/// with strict FIFO ordering when the slot is full.
/// </summary>
public interface IPerUserConcurrency
{
    /// <summary>
    /// Acquires a per-user concurrency slot for the given principal and job.
    /// If the per-user limit is exhausted the caller waits in FIFO order until a slot becomes available.
    /// </summary>
    /// <param name="principal">The principal whose budget the slot is charged against.</param>
    /// <param name="jobId">The job requesting the slot.</param>
    /// <param name="ct">Cancellation token. Cancellation removes the waiter from the queue.</param>
    /// <returns>A <see cref="UserAdmission"/> that releases the slot when disposed.</returns>
    ValueTask<UserAdmission> AcquireAsync(AuthContext principal, JobId jobId, CancellationToken ct);

    /// <summary>Returns the number of currently active (admitted, not yet released) slots for <paramref name="principal"/>.</summary>
    /// <param name="principal">The principal to query.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The active slot count.</returns>
    ValueTask<int> GetActiveCountAsync(AuthContext principal, CancellationToken ct);
}
