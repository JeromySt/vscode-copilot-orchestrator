// <copyright file="HostAdmission.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Concurrency.Broker;

/// <summary>
/// Represents a granted host-level concurrency slot. Disposing the handle sends a
/// release notification to the broker daemon, freeing the slot.
/// </summary>
public sealed class HostAdmission : IAsyncDisposable
{
    private readonly Func<string, ValueTask> release;
    private int disposed;

    [System.Diagnostics.CodeAnalysis.SetsRequiredMembers]
    internal HostAdmission(
        AuthContext principal,
        JobId jobId,
        DateTimeOffset admittedAt,
        string brokerLeaseId,
        Func<string, ValueTask> release)
    {
        this.Principal = principal;
        this.JobId = jobId;
        this.AdmittedAt = admittedAt;
        this.BrokerLeaseId = brokerLeaseId;
        this.release = release;
    }

    /// <summary>Gets the principal that was admitted.</summary>
    public required AuthContext Principal { get; init; }

    /// <summary>Gets the job that holds this host admission slot.</summary>
    public required JobId JobId { get; init; }

    /// <summary>Gets the UTC timestamp when the slot was granted.</summary>
    public required DateTimeOffset AdmittedAt { get; init; }

    /// <summary>Gets the broker-assigned lease identifier.</summary>
    public required string BrokerLeaseId { get; init; }

    /// <inheritdoc/>
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref this.disposed, 1) == 0)
        {
            await this.release(this.BrokerLeaseId).ConfigureAwait(false);
        }
    }
}
