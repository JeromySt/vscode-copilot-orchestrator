// <copyright file="FairnessScheduler.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Concurrency.Broker.Events;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Concurrency.Broker.Fairness;

/// <summary>
/// Schedules host-wide concurrency slots across multiple principals using either
/// <see cref="HostFairness.Proportional"/> or <see cref="HostFairness.StrictRoundRobin"/> fairness.
/// </summary>
public sealed class FairnessScheduler
{
    private const int AdmissionRateWindowSeconds = 30;

    // Readonly fields first (SA1214)
    private readonly IClock clock;
    private readonly IOptionsMonitor<BrokerOptions> opts;
    private readonly IEventBus bus;
    private readonly SemaphoreSlim slotLock = new(1, 1);
    private readonly LinkedList<PendingRequest> pendingRequests = new();
    private readonly Dictionary<string, PrincipalStats> principalStats = [];
    private readonly List<string> roundRobinOrder = [];
    private readonly Queue<DateTimeOffset> recentAdmissions = new();

    // Non-readonly fields after (SA1214)
    private int activeSlots;
    private int roundRobinIndex;

    /// <summary>
    /// Initializes a new instance of the <see cref="FairnessScheduler"/> class.
    /// </summary>
    /// <param name="clock">The clock used for timestamps and ETA estimation.</param>
    /// <param name="opts">Options controlling the max concurrency and fairness mode.</param>
    /// <param name="bus">The event bus for publishing queued notifications.</param>
    public FairnessScheduler(IClock clock, IOptionsMonitor<BrokerOptions> opts, IEventBus bus)
    {
        this.clock = clock;
        this.opts = opts;
        this.bus = bus;
    }

    /// <summary>
    /// Enqueues a request for a concurrency slot and returns when admitted.
    /// </summary>
    /// <param name="principal">The requesting principal.</param>
    /// <param name="job">The job requesting the slot.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="FairnessDecision"/> describing the lease and estimated wait.</returns>
    public async ValueTask<FairnessDecision> EnqueueAsync(AuthContext principal, JobId job, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var enqueuedAt = this.clock.UtcNow;
        var leaseId = $"broker-{Guid.NewGuid():N}";
        TaskCompletionSource<(DateTimeOffset AdmittedAt, int Position)>? waiter = null;
        int queuePosition = 0;

        await this.slotLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var options = this.opts.CurrentValue;
            this.EnsurePrincipalTracked(principal.PrincipalId);

            if (this.activeSlots < options.MaxConcurrentHostWide
                && this.IsNextInFairOrder(principal.PrincipalId, options.HostFairness))
            {
                // Admit immediately.
                this.activeSlots++;
                this.principalStats[principal.PrincipalId].ActiveCount++;
                this.RecordAdmission();
                return new FairnessDecision
                {
                    LeaseId = leaseId,
                    EstimatedWait = TimeSpan.Zero,
                    QueuePosition = 0,
                };
            }

            // Enqueue.
            queuePosition = this.pendingRequests.Count;
            waiter = new TaskCompletionSource<(DateTimeOffset, int)>(TaskCreationOptions.RunContinuationsAsynchronously);
            var request = new PendingRequest(principal, job, leaseId, waiter, enqueuedAt);
            _ = this.pendingRequests.AddLast(request);
            this.principalStats[principal.PrincipalId].QueuedCount++;

            // Publish ConcurrencyHostQueued.
            var eta = this.EstimateEta(queuePosition);
            var hint = this.BuildActionableHint(principal.PrincipalId, queuePosition, options);
            var queuedEvent = new ConcurrencyHostQueued
            {
                Principal = principal,
                JobId = job,
                QueuePosition = queuePosition,
                EtaSeconds = eta,
                ActionableHint = hint,
                At = enqueuedAt,
            };
            _ = Task.Run(async () => await this.bus.PublishAsync(queuedEvent, CancellationToken.None).ConfigureAwait(false));
        }
        finally
        {
            _ = this.slotLock.Release();
        }

        // Wait for admission.
        try
        {
            using var reg = ct.Register(() => _ = waiter!.TrySetCanceled(ct));
            var (admittedAt, position) = await waiter!.Task.ConfigureAwait(false);
            return new FairnessDecision
            {
                LeaseId = leaseId,
                EstimatedWait = admittedAt - enqueuedAt,
                QueuePosition = position,
            };
        }
        catch (OperationCanceledException)
        {
            // Remove from queue.
            await this.slotLock.WaitAsync(CancellationToken.None).ConfigureAwait(false);
            try
            {
                var node = this.pendingRequests.First;
                while (node != null)
                {
                    if (ReferenceEquals(node.Value.Waiter, waiter))
                    {
                        this.pendingRequests.Remove(node);
                        this.principalStats[principal.PrincipalId].QueuedCount--;
                        break;
                    }

                    node = node.Next;
                }
            }
            finally
            {
                _ = this.slotLock.Release();
            }

            throw;
        }
    }

    /// <summary>Releases a previously admitted slot and potentially admits the next request.</summary>
    /// <param name="principalId">The principal releasing the slot.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when the release is processed.</returns>
    public async ValueTask ReleaseAsync(string principalId, CancellationToken ct = default)
    {
        TaskCompletionSource<(DateTimeOffset, int)>? nextWaiter = null;
        DateTimeOffset admittedAt = default;
        int position = 0;

        await this.slotLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            this.activeSlots--;
            if (this.principalStats.TryGetValue(principalId, out var stats))
            {
                stats.ActiveCount--;
            }

            // Try to admit the next pending request according to fairness policy.
            var options = this.opts.CurrentValue;
            var next = this.PickNext(options.HostFairness);
            if (next != null)
            {
                this.pendingRequests.Remove(next);
                this.principalStats[next.Value.Principal.PrincipalId].QueuedCount--;
                this.activeSlots++;
                this.principalStats[next.Value.Principal.PrincipalId].ActiveCount++;
                this.RecordAdmission();
                nextWaiter = next.Value.Waiter;
                admittedAt = this.clock.UtcNow;
                position = next.Value.OriginalQueuePosition;
            }
        }
        finally
        {
            _ = this.slotLock.Release();
        }

        _ = nextWaiter?.TrySetResult((admittedAt, position));
    }

    /// <summary>Returns all pending waiter TCSes to cancel them on shutdown.</summary>
    /// <returns>
    /// A <see cref="ValueTask{TResult}"/> containing the list of pending waiters
    /// that the caller should cancel.
    /// </returns>
    /// <param name="ct">Cancellation token.</param>
    public async ValueTask<IReadOnlyList<TaskCompletionSource<(DateTimeOffset AdmittedAt, int Position)>>> DrainAsync(CancellationToken ct = default)
    {
        await this.slotLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var waiters = this.pendingRequests.Select(r => r.Waiter).ToList();
            this.pendingRequests.Clear();
            return waiters;
        }
        finally
        {
            _ = this.slotLock.Release();
        }
    }

    private void EnsurePrincipalTracked(string principalId)
    {
        if (!this.principalStats.ContainsKey(principalId))
        {
            this.principalStats[principalId] = new PrincipalStats();
            this.roundRobinOrder.Add(principalId);
        }
    }

    private bool IsNextInFairOrder(string principalId, HostFairness fairness)
    {
        if (fairness == HostFairness.Proportional)
        {
            // Proportional: admit if this principal is not over-represented.
            var activePrincipals = this.principalStats.Values.Count(s => s.ActiveCount > 0 || s.QueuedCount > 0);
            if (activePrincipals == 0)
            {
                return true;
            }

            var options = this.opts.CurrentValue;
            var fairShare = (double)options.MaxConcurrentHostWide / activePrincipals;
            var myActive = this.principalStats[principalId].ActiveCount;
            return myActive < Math.Ceiling(fairShare);
        }
        else
        {
            // StrictRoundRobin: only admit if no pending requests.
            return this.pendingRequests.Count == 0;
        }
    }

    private LinkedListNode<PendingRequest>? PickNext(HostFairness fairness)
    {
        if (this.pendingRequests.Count == 0)
        {
            return null;
        }

        if (fairness == HostFairness.StrictRoundRobin)
        {
            // Find the next principal in round-robin order that has a queued request.
            for (var i = 0; i < this.roundRobinOrder.Count; i++)
            {
                var idx = (this.roundRobinIndex + i) % this.roundRobinOrder.Count;
                var principalId = this.roundRobinOrder[idx];
                var node = this.pendingRequests.First;
                while (node != null)
                {
                    if (node.Value.Principal.PrincipalId == principalId)
                    {
                        this.roundRobinIndex = (idx + 1) % this.roundRobinOrder.Count;
                        return node;
                    }

                    node = node.Next;
                }
            }

            // Fallback: admit first in queue.
            return this.pendingRequests.First;
        }
        else
        {
            // Proportional: pick from the principal with the smallest active count.
            LinkedListNode<PendingRequest>? best = null;
            var bestActive = int.MaxValue;
            var node = this.pendingRequests.First;
            while (node != null)
            {
                var pid = node.Value.Principal.PrincipalId;
                var active = this.principalStats.TryGetValue(pid, out var s) ? s.ActiveCount : 0;
                if (active < bestActive)
                {
                    bestActive = active;
                    best = node;
                }

                node = node.Next;
            }

            return best;
        }
    }

    private void RecordAdmission()
    {
        var now = this.clock.UtcNow;
        this.recentAdmissions.Enqueue(now);
        var cutoff = now.AddSeconds(-AdmissionRateWindowSeconds);
        while (this.recentAdmissions.Count > 0 && this.recentAdmissions.Peek() < cutoff)
        {
            _ = this.recentAdmissions.Dequeue();
        }
    }

    private TimeSpan EstimateEta(int queuePosition)
    {
        if (this.recentAdmissions.Count == 0)
        {
            return TimeSpan.FromSeconds(queuePosition * 5);
        }

        var rate = this.recentAdmissions.Count / (double)AdmissionRateWindowSeconds;
        if (rate <= 0)
        {
            return TimeSpan.FromSeconds(queuePosition * 5);
        }

        return TimeSpan.FromSeconds((queuePosition + 1) / rate);
    }

    private string BuildActionableHint(string principalId, int queuePosition, BrokerOptions options)
    {
        var myQueued = this.principalStats.TryGetValue(principalId, out var s) ? s.QueuedCount : 0;
        if (myQueued > 0)
        {
            return $"{myQueued} job(s) ahead from same user, consider raising MaxConcurrentPerUser";
        }

        return $"{queuePosition} job(s) ahead in host queue (MaxConcurrentHostWide={options.MaxConcurrentHostWide})";
    }

    private sealed class PrincipalStats
    {
        public int ActiveCount { get; set; }

        public int QueuedCount { get; set; }
    }

    private sealed record PendingRequest(
        AuthContext Principal,
        JobId Job,
        string LeaseId,
        TaskCompletionSource<(DateTimeOffset AdmittedAt, int Position)> Waiter,
        DateTimeOffset EnqueuedAt)
    {
        public int OriginalQueuePosition { get; set; }
    }
}
