// <copyright file="HostConcurrencyBrokerClient.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Concurrency.Broker.Exceptions;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Concurrency.Broker;

/// <summary>
/// Production client for the host concurrency broker.
/// When the broker daemon is running in-process, delegates directly.
/// When unavailable, falls back to passthrough mode (INV-9).
/// </summary>
public sealed class HostConcurrencyBrokerClient : IHostConcurrencyBrokerClient
{
    private readonly HostConcurrencyBrokerDaemon? daemon;
    private readonly ILogger<HostConcurrencyBrokerClient> logger;
    private bool warnedUnavailable;

    /// <summary>
    /// Initializes a new instance of the <see cref="HostConcurrencyBrokerClient"/> class.
    /// </summary>
    /// <param name="daemon">
    /// The in-process daemon, if available. Pass <see langword="null"/> to always use passthrough mode.
    /// </param>
    /// <param name="logger">Logger for diagnostic output.</param>
    public HostConcurrencyBrokerClient(HostConcurrencyBrokerDaemon? daemon, ILogger<HostConcurrencyBrokerClient> logger)
    {
        this.daemon = daemon;
        this.logger = logger;
    }

    /// <inheritdoc/>
    public async ValueTask<HostAdmission> AcquireAsync(AuthContext principal, JobId job, CancellationToken ct)
    {
        if (this.daemon != null)
        {
            try
            {
                return await this.daemon.AcquireAsync(principal, job, ct).ConfigureAwait(false);
            }
            catch (BrokerUnavailableException)
            {
                this.LogUnavailableOnce();
                return this.CreatePassthroughAdmission(principal, job);
            }
        }

        this.LogUnavailableOnce();
        return this.CreatePassthroughAdmission(principal, job);
    }

    private void LogUnavailableOnce()
    {
        if (!this.warnedUnavailable)
        {
            this.warnedUnavailable = true;
            this.logger.LogWarning(
                "Host concurrency broker is unavailable. Falling back to per-user limiting only (no host-wide fairness).");
        }
    }

    private HostAdmission CreatePassthroughAdmission(AuthContext principal, JobId job)
    {
        var leaseId = $"passthrough-{Guid.NewGuid():N}";
        return new HostAdmission(principal, job, DateTimeOffset.UtcNow, leaseId, _ => ValueTask.CompletedTask);
    }
}
