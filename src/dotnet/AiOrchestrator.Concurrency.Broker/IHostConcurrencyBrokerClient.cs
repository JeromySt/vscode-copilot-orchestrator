// <copyright file="IHostConcurrencyBrokerClient.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Concurrency.Broker;

/// <summary>
/// Client interface for acquiring host-wide concurrency slots from the broker daemon.
/// When the daemon is unavailable the client falls back to per-user limiting only (INV-9).
/// </summary>
public interface IHostConcurrencyBrokerClient
{
    /// <summary>
    /// Acquires a host-level concurrency slot for the given principal and job.
    /// If the daemon is unavailable, returns a passthrough admission without host-level coordination.
    /// </summary>
    /// <param name="principal">The principal requesting the slot.</param>
    /// <param name="job">The job requesting the slot.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="HostAdmission"/> that releases the slot when disposed.</returns>
    ValueTask<HostAdmission> AcquireAsync(AuthContext principal, JobId job, CancellationToken ct);
}
