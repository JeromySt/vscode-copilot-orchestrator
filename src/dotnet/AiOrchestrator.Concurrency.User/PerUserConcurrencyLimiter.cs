// <copyright file="PerUserConcurrencyLimiter.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Concurrent;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Concurrency.User.Events;
using AiOrchestrator.Concurrency.User.Exceptions;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Concurrency.User;

/// <summary>
/// Per-user FIFO concurrency limiter. Maintains a separate slot budget and wait
/// queue for each principal. Waiters are admitted in strict FIFO arrival order.
/// </summary>
public sealed class PerUserConcurrencyLimiter : IPerUserConcurrency, IAsyncDisposable
{
    private readonly IClock clock;
    private readonly IEventBus bus;
    private readonly IOptionsMonitor<UserConcurrencyOptions> opts;
    private readonly ConcurrentDictionary<string, UserSlot> slots = new(StringComparer.Ordinal);
    private volatile bool disposed;

    /// <summary>
    /// Initializes a new instance of the <see cref="PerUserConcurrencyLimiter"/> class.
    /// </summary>
    /// <param name="clock">The clock used for timestamping admissions.</param>
    /// <param name="bus">The event bus used to publish concurrency lifecycle events.</param>
    /// <param name="opts">Options controlling per-user limits and queue depth.</param>
    public PerUserConcurrencyLimiter(
        IClock clock,
        IEventBus bus,
        IOptionsMonitor<UserConcurrencyOptions> opts)
    {
        this.clock = clock;
        this.bus = bus;
        this.opts = opts;
    }

    /// <inheritdoc/>
    public async ValueTask<UserAdmission> AcquireAsync(AuthContext principal, JobId jobId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        if (this.disposed)
        {
            throw new ObjectDisposedException(nameof(PerUserConcurrencyLimiter));
        }

        var options = this.opts.CurrentValue;
        var slot = this.slots.GetOrAdd(principal.PrincipalId, _ => new UserSlot());

        Waiter? waiter = null;
        int queuePosition = 0;
        DateTimeOffset queuedAt = default;

        lock (slot)
        {
            if (slot.CanAdmit(options.MaxConcurrentPerUser))
            {
                slot.IncrementActive();
                var admittedAt = this.clock.UtcNow;
                return new UserAdmission(principal, jobId, admittedAt, this.ReleaseAsync);
            }

            if (slot.QueueCount >= options.FifoQueueDepth)
            {
                throw new UserConcurrencyQueueFullException(options.FifoQueueDepth);
            }

            queuedAt = this.clock.UtcNow;
            waiter = new Waiter(jobId, queuedAt, principal);
            slot.Enqueue(waiter, out queuePosition);
        }

        await this.bus.PublishAsync(
            new ConcurrencyUserQueued { JobId = jobId, QueuePosition = queuePosition, At = queuedAt },
            CancellationToken.None).ConfigureAwait(false);

        using (ct.Register(
            state =>
            {
                var (s, w, token) = ((UserSlot, Waiter, CancellationToken))state!;
                bool removed;
                lock (s)
                {
                    removed = s.TryRemove(w);
                }

                if (removed)
                {
                    _ = w.Tcs.TrySetCanceled(token);
                }
            },
            (slot, waiter, ct)))
        {
            return await waiter.Tcs.Task.ConfigureAwait(false);
        }
    }

    /// <inheritdoc/>
    public ValueTask<int> GetActiveCountAsync(AuthContext principal, CancellationToken ct)
    {
        if (this.slots.TryGetValue(principal.PrincipalId, out var slot))
        {
            lock (slot)
            {
                return ValueTask.FromResult(slot.ActiveCount);
            }
        }

        return ValueTask.FromResult(0);
    }

    /// <inheritdoc/>
    public ValueTask DisposeAsync()
    {
        this.disposed = true;

        foreach (var slot in this.slots.Values)
        {
            lock (slot)
            {
                Waiter? w;
                while ((w = slot.TryDequeue()) != null)
                {
                    _ = w.Tcs.TrySetCanceled();
                }
            }
        }

        return ValueTask.CompletedTask;
    }

    private async ValueTask ReleaseAsync(AuthContext principal, JobId jobId)
    {
        if (!this.slots.TryGetValue(principal.PrincipalId, out var slot))
        {
            return;
        }

        Waiter? granted = null;
        DateTimeOffset grantedAt = default;

        lock (slot)
        {
            Waiter? candidate;
            while ((candidate = slot.TryDequeue()) != null)
            {
                grantedAt = this.clock.UtcNow;
                var admission = new UserAdmission(candidate.Principal, candidate.JobId, grantedAt, this.ReleaseAsync);
                if (candidate.Tcs.TrySetResult(admission))
                {
                    granted = candidate;
                    break;
                }
            }

            if (granted == null)
            {
                slot.DecrementActive();
            }
        }

        if (granted != null)
        {
            await this.bus.PublishAsync(
                new ConcurrencyUserAdmitted
                {
                    JobId = granted.JobId,
                    WaitTime = grantedAt - granted.QueuedAt,
                    At = grantedAt,
                },
                CancellationToken.None).ConfigureAwait(false);
        }
    }

    private sealed class UserSlot
    {
        private readonly LinkedList<Waiter> queue = new();
        private int active;

        public int ActiveCount => this.active;

        public int QueueCount => this.queue.Count;

        public bool CanAdmit(int max) => this.active < max;

        public void IncrementActive() => this.active++;

        public void DecrementActive() => this.active--;

        public void Enqueue(Waiter waiter, out int position)
        {
            var node = this.queue.AddLast(waiter);
            waiter.Node = node;
            position = this.queue.Count - 1;
        }

        public Waiter? TryDequeue()
        {
            if (this.queue.Count == 0)
            {
                return null;
            }

            var waiter = this.queue.First!.Value;
            this.queue.RemoveFirst();
            waiter.Node = null;
            return waiter;
        }

        public bool TryRemove(Waiter waiter)
        {
            if (waiter.Node == null)
            {
                return false;
            }

            this.queue.Remove(waiter.Node);
            waiter.Node = null;
            return true;
        }
    }

    private sealed class Waiter
    {
        public Waiter(JobId jobId, DateTimeOffset queuedAt, AuthContext principal)
        {
            this.JobId = jobId;
            this.QueuedAt = queuedAt;
            this.Principal = principal;
            this.Tcs = new TaskCompletionSource<UserAdmission>(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        public JobId JobId { get; }

        public DateTimeOffset QueuedAt { get; }

        public AuthContext Principal { get; }

        public TaskCompletionSource<UserAdmission> Tcs { get; }

        public LinkedListNode<Waiter>? Node { get; set; }
    }
}
