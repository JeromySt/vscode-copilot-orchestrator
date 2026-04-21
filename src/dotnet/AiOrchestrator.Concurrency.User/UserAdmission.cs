// <copyright file="UserAdmission.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Concurrency.User;

/// <summary>
/// Represents a granted per-user concurrency slot. Disposing the handle releases the slot,
/// which may admit the next waiter in the FIFO queue.
/// </summary>
public sealed class UserAdmission : IAsyncDisposable
{
    private readonly Func<AuthContext, JobId, ValueTask> release;
    private int disposed;

    internal UserAdmission(
        AuthContext principal,
        JobId jobId,
        DateTimeOffset admittedAt,
        Func<AuthContext, JobId, ValueTask> release)
    {
        this.Principal = principal;
        this.JobId = jobId;
        this.AdmittedAt = admittedAt;
        this.release = release;
    }

    /// <summary>Gets the principal that was admitted.</summary>
    public AuthContext Principal { get; }

    /// <summary>Gets the job that holds this per-user admission slot.</summary>
    public JobId JobId { get; }

    /// <summary>Gets the UTC timestamp when the slot was granted.</summary>
    public DateTimeOffset AdmittedAt { get; }

    /// <inheritdoc/>
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref this.disposed, 1) == 0)
        {
            await this.release(this.Principal, this.JobId).ConfigureAwait(false);
        }
    }
}
