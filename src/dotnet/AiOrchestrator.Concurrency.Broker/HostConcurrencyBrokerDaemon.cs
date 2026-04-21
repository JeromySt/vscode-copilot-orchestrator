// <copyright file="HostConcurrencyBrokerDaemon.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Concurrency.Broker.Events;
using AiOrchestrator.Concurrency.Broker.Fairness;
using AiOrchestrator.Concurrency.Broker.Rpc;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Concurrency.Broker;

/// <summary>
/// Host-wide concurrency broker daemon. Owns the global semaphore and
/// arbitrates slot allocation across multiple AIO clients on the same host.
/// Implements INV-1 through INV-8.
/// </summary>
public sealed class HostConcurrencyBrokerDaemon : IHostedService, IAsyncDisposable
{
    private readonly IRpcServer rpc;
    private readonly FairnessScheduler scheduler;
    private readonly IClock clock;
    private readonly IEventBus bus;
    private readonly IOptionsMonitor<BrokerOptions> opts;
    private readonly ILogger<HostConcurrencyBrokerDaemon> logger;

    // Active leases: leaseId -> (principal, jobId, admittedAt)
    private readonly Dictionary<string, LeaseEntry> activeLeases = [];
    private readonly SemaphoreSlim leaseLock = new(1, 1);
    private Timer? ttlTimer;
    private bool shuttingDown;
    private int disposedFlag;

    /// <summary>
    /// Initializes a new instance of the <see cref="HostConcurrencyBrokerDaemon"/> class.
    /// </summary>
    /// <param name="rpc">The IPC server (UDS or named-pipe) for client connections.</param>
    /// <param name="scheduler">The fairness scheduler that arbitrates slot allocation.</param>
    /// <param name="clock">The clock for timestamping and TTL enforcement.</param>
    /// <param name="bus">The event bus for publishing lifecycle events.</param>
    /// <param name="opts">Options controlling the broker's behavior.</param>
    /// <param name="logger">Logger for diagnostic output.</param>
    public HostConcurrencyBrokerDaemon(
        IRpcServer rpc,
        FairnessScheduler scheduler,
        IClock clock,
        IEventBus bus,
        IOptionsMonitor<BrokerOptions> opts,
        ILogger<HostConcurrencyBrokerDaemon> logger)
    {
        this.rpc = rpc;
        this.scheduler = scheduler;
        this.clock = clock;
        this.bus = bus;
        this.opts = opts;
        this.logger = logger;
    }

    /// <inheritdoc/>
    public async Task StartAsync(CancellationToken ct)
    {
        this.logger.LogInformation("Host concurrency broker daemon starting.");
        await this.rpc.StartAsync(ct).ConfigureAwait(false);

        // Start TTL enforcement timer (check every 30s).
        this.ttlTimer = new Timer(
            this.OnTtlTimerElapsed,
            null,
            TimeSpan.FromSeconds(30),
            TimeSpan.FromSeconds(30));

        this.logger.LogInformation(
            "Host concurrency broker daemon started (MaxConcurrentHostWide={Max}, Fairness={Fairness}).",
            this.opts.CurrentValue.MaxConcurrentHostWide,
            this.opts.CurrentValue.HostFairness);
    }

    /// <inheritdoc/>
    public async Task StopAsync(CancellationToken ct)
    {
        this.logger.LogInformation("Host concurrency broker daemon stopping (draining in-flight admissions).");

        await this.leaseLock.WaitAsync(CancellationToken.None).ConfigureAwait(false);
        try
        {
            this.shuttingDown = true;
        }
        finally
        {
            _ = this.leaseLock.Release();
        }

        // Drain queued waiters.
        var waiters = await this.scheduler.DrainAsync().ConfigureAwait(false);
        foreach (var w in waiters)
        {
            _ = w.TrySetCanceled();
        }

        await this.rpc.StopAsync(ct).ConfigureAwait(false);
        this.logger.LogInformation("Host concurrency broker daemon stopped.");
    }

    /// <inheritdoc/>
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref this.disposedFlag, 1) == 0)
        {
            this.ttlTimer?.Dispose();
            await this.rpc.DisposeAsync().ConfigureAwait(false);
            this.leaseLock.Dispose();
        }
    }

    /// <summary>
    /// Acquires a host-level slot on behalf of the broker daemon. Called by the local
    /// in-process client path when there is no IPC hop.
    /// </summary>
    /// <param name="principal">The requesting principal.</param>
    /// <param name="job">The requesting job.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="HostAdmission"/> that releases the slot when disposed.</returns>
    internal async ValueTask<HostAdmission> AcquireAsync(AuthContext principal, JobId job, CancellationToken ct)
    {
        await this.leaseLock.WaitAsync(ct).ConfigureAwait(false);
        bool isShuttingDown;
        try
        {
            isShuttingDown = this.shuttingDown;
        }
        finally
        {
            _ = this.leaseLock.Release();
        }

        if (isShuttingDown)
        {
            var socketPath = this.opts.CurrentValue.SocketPath;
            throw new Exceptions.BrokerUnavailableException(socketPath);
        }

        var decision = await this.scheduler.EnqueueAsync(principal, job, ct).ConfigureAwait(false);
        var admittedAt = this.clock.UtcNow;

        // Register lease for TTL enforcement.
        await this.leaseLock.WaitAsync(CancellationToken.None).ConfigureAwait(false);
        try
        {
            this.activeLeases[decision.LeaseId] = new LeaseEntry(principal, job, admittedAt);
        }
        finally
        {
            _ = this.leaseLock.Release();
        }

        return new HostAdmission(principal, job, admittedAt, decision.LeaseId, this.ReleaseAsync);
    }

    /// <summary>Exposes lease expiry check for testing. Production code uses a timer.</summary>
    internal Task TriggerExpiryCheckAsync() => this.ExpireLeasesAsync();

    private void OnTtlTimerElapsed(object? state)
    {
        _ = Task.Run(() => this.ExpireLeasesAsync());
    }

    private async ValueTask ReleaseAsync(string leaseId)
    {
        // If already disposed, nothing to release.
        if (Volatile.Read(ref this.disposedFlag) != 0)
        {
            return;
        }

        AuthContext? principal = null;

        try
        {
            await this.leaseLock.WaitAsync(CancellationToken.None).ConfigureAwait(false);
        }
        catch (ObjectDisposedException)
        {
            return;
        }

        try
        {
            if (this.activeLeases.TryGetValue(leaseId, out var entry))
            {
                principal = entry.Principal;
                _ = this.activeLeases.Remove(leaseId);
            }
        }
        finally
        {
            _ = this.leaseLock.Release();
        }

        if (principal != null)
        {
            await this.scheduler.ReleaseAsync(principal.PrincipalId).ConfigureAwait(false);
        }
    }

    private async Task ExpireLeasesAsync()
    {
        var now = this.clock.UtcNow;
        var ttl = this.opts.CurrentValue.LeaseTtl;
        List<(string LeaseId, LeaseEntry Entry)>? expired = null;

        await this.leaseLock.WaitAsync(CancellationToken.None).ConfigureAwait(false);
        try
        {
            foreach (var kvp in this.activeLeases)
            {
                if (now - kvp.Value.AdmittedAt > ttl)
                {
                    expired ??= [];
                    expired.Add((kvp.Key, kvp.Value));
                }
            }

            if (expired != null)
            {
                foreach (var (leaseId, _) in expired)
                {
                    _ = this.activeLeases.Remove(leaseId);
                }
            }
        }
        finally
        {
            _ = this.leaseLock.Release();
        }

        if (expired != null)
        {
            foreach (var (leaseId, entry) in expired)
            {
                this.logger.LogWarning(
                    "Broker lease {LeaseId} expired for {PrincipalId}/{JobId}.",
                    leaseId,
                    entry.Principal.PrincipalId,
                    entry.JobId);

                await this.scheduler.ReleaseAsync(entry.Principal.PrincipalId).ConfigureAwait(false);

                var expiredEvt = new HostAdmissionExpired
                {
                    Principal = entry.Principal,
                    JobId = entry.JobId,
                    BrokerLeaseId = leaseId,
                    ExpiredAt = now,
                };

                // Publish directly — no lock is held at this point.
                await this.bus.PublishAsync(expiredEvt, CancellationToken.None).ConfigureAwait(false);
            }
        }
    }

    private sealed record LeaseEntry(AuthContext Principal, JobId JobId, DateTimeOffset AdmittedAt);
}
