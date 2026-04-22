// <copyright file="PlanScheduler.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Concurrency.Broker;
using AiOrchestrator.Concurrency.User;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.Scheduler.Channels;
using AiOrchestrator.Plan.Scheduler.Events;
using AiOrchestrator.Plan.Scheduler.Ready;
using AiOrchestrator.Plan.Store;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Plan.Scheduler;

/// <summary>
/// Orchestrates DAG-based plan execution: walks the ready set, admits jobs via concurrency
/// limiters, emits scheduling events, applies T22/T14 race rules, and dispatches to the
/// phase executor. Implements <see cref="IHostedService"/> so it runs as a background service.
/// </summary>
public sealed class PlanScheduler : IHostedService, IAsyncDisposable
{
    private readonly IPlanStore store;
    private readonly IPerUserConcurrency userConc;
    private readonly IHostConcurrencyBrokerClient hostConc;
    private readonly IEventBus bus;
    private readonly IClock clock;
    private readonly IPhaseExecutor phaseExec;
    private readonly IOptionsMonitor<SchedulerOptions> opts;
    private readonly ILogger<PlanScheduler> logger;

    private readonly ConcurrentDictionary<string, PlanEntry> plans = new();
    private readonly ConcurrentDictionary<string, string> jobToPlan = new();
    private readonly SchedulingChannels channels;
    private readonly SemaphoreSlim globalSemaphore;

    private CancellationTokenSource? stopCts;
    private Task? dispatchLoop;
    private Task? watchLoop;

    /// <summary>
    /// Initializes a new instance of the <see cref="PlanScheduler"/> class.
    /// </summary>
    /// <param name="store">The plan store providing plan watch subscriptions.</param>
    /// <param name="userConc">The per-user concurrency limiter.</param>
    /// <param name="hostConc">The host-wide concurrency broker client.</param>
    /// <param name="bus">The event bus for publishing scheduling events.</param>
    /// <param name="clock">The clock for timestamping events.</param>
    /// <param name="phaseExec">The phase executor that performs the actual work.</param>
    /// <param name="opts">The scheduler options monitor.</param>
    /// <param name="logger">The component logger.</param>
    public PlanScheduler(
        IPlanStore store,
        IPerUserConcurrency userConc,
        IHostConcurrencyBrokerClient hostConc,
        IEventBus bus,
        IClock clock,
        IPhaseExecutor phaseExec,
        IOptionsMonitor<SchedulerOptions> opts,
        ILogger<PlanScheduler> logger)
    {
        this.store = store;
        this.userConc = userConc;
        this.hostConc = hostConc;
        this.bus = bus;
        this.clock = clock;
        this.phaseExec = phaseExec;
        this.opts = opts;
        this.logger = logger;
        this.channels = new SchedulingChannels(opts);
        this.globalSemaphore = new SemaphoreSlim(opts.CurrentValue.GlobalMaxParallel);
    }

    /// <inheritdoc/>
    public Task StartAsync(CancellationToken ct)
    {
        this.stopCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var token = this.stopCts.Token;

        this.watchLoop = Task.Run(() => this.RunWatchLoopAsync(token), token);
        this.dispatchLoop = Task.Run(() => this.RunDispatchLoopAsync(token), token);

        this.logger.LogInformation("PlanScheduler started.");
        return Task.CompletedTask;
    }

    /// <inheritdoc/>
    public async Task StopAsync(CancellationToken ct)
    {
        if (this.stopCts is not null)
        {
            await this.stopCts.CancelAsync().ConfigureAwait(false);
        }

        try
        {
            if (this.watchLoop is not null)
            {
                await this.watchLoop.ConfigureAwait(false);
            }

            if (this.dispatchLoop is not null)
            {
                await this.dispatchLoop.ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
        }

        this.logger.LogInformation("PlanScheduler stopped.");
    }

    /// <summary>Pauses scheduling of new jobs for the specified plan (INV-9). In-flight jobs may continue.</summary>
    /// <param name="planId">The plan to pause.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A value task that completes when the pause is applied.</returns>
    public ValueTask PauseAsync(PlanId planId, CancellationToken ct)
    {
        if (this.plans.TryGetValue(planId.ToString(), out var entry))
        {
            entry.Paused = true;
            this.logger.LogInformation("Plan {PlanId} paused.", planId);
        }

        return ValueTask.CompletedTask;
    }

    /// <summary>Resumes scheduling for a previously paused plan.</summary>
    /// <param name="planId">The plan to resume.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A value task that completes when the resume is applied.</returns>
    public ValueTask ResumeAsync(PlanId planId, CancellationToken ct)
    {
        if (this.plans.TryGetValue(planId.ToString(), out var entry))
        {
            entry.Paused = false;
            this.logger.LogInformation("Plan {PlanId} resumed.", planId);
        }

        return ValueTask.CompletedTask;
    }

    /// <summary>
    /// Cancels the plan: flips plan status to Canceled, cancels all in-flight job CTs,
    /// and transitions all Pending jobs to Canceled (INV-10).
    /// </summary>
    /// <param name="planId">The plan to cancel.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A value task that completes after all cancellations are initiated.</returns>
    public async ValueTask CancelAsync(PlanId planId, CancellationToken ct)
    {
        if (!this.plans.TryGetValue(planId.ToString(), out var entry))
        {
            return;
        }

        await entry.PlanCts.CancelAsync().ConfigureAwait(false);

        var plan = await this.store.LoadAsync(planId, ct).ConfigureAwait(false);
        if (plan is null)
        {
            return;
        }

        foreach (var (_, job) in plan.Jobs)
        {
            if (job.Status == JobStatus.Pending || job.Status == JobStatus.Ready)
            {
                var idemKey = IdempotencyKey.FromGuid(Guid.NewGuid());
                await this.store.MutateAsync(
                    planId,
                    new JobStatusUpdated(0, idemKey, this.clock.UtcNow, job.Id, JobStatus.Canceled),
                    idemKey,
                    ct).ConfigureAwait(false);
            }
        }

        var planIdemKey = IdempotencyKey.FromGuid(Guid.NewGuid());
        await this.store.MutateAsync(
            planId,
            new PlanStatusUpdated(0, planIdemKey, this.clock.UtcNow, PlanStatus.Canceled),
            planIdemKey,
            ct).ConfigureAwait(false);

        this.logger.LogInformation("Plan {PlanId} canceled.", planId);
    }

    /// <inheritdoc/>
    public ValueTask DisposeAsync()
    {
        this.channels.Complete();
        this.globalSemaphore.Dispose();
        this.stopCts?.Dispose();
        return ValueTask.CompletedTask;
    }

    private async Task RunWatchLoopAsync(CancellationToken ct)
    {
        try
        {
            await foreach (var plan in this.store.ListAsync(ct).ConfigureAwait(false))
            {
                var planIdStr = plan.Id;
                if (!PlanId.TryParse(planIdStr, out var planId))
                {
                    continue;
                }

                var entry = this.plans.GetOrAdd(planIdStr, _ => new PlanEntry(planId));
                _ = Task.Run(() => this.WatchPlanAsync(planId, entry, ct), ct);
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            this.logger.LogError(ex, "Watch loop failed.");
        }
    }

    private async Task WatchPlanAsync(PlanId planId, PlanEntry entry, CancellationToken ct)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, entry.PlanCts.Token);
        try
        {
            await foreach (var plan in this.store.WatchAsync(planId, linked.Token).ConfigureAwait(false))
            {
                if (entry.Paused)
                {
                    continue;
                }

                var statuses = plan.Jobs
                    .Where(kvp => JobId.TryParse(kvp.Key, out _))
                    .ToDictionary(
                        kvp => JobId.Parse(kvp.Key),
                        kvp => kvp.Value.Status);

                var graph = new PlanGraph(plan);
                var readySet = new ReadySet(graph);
                var ready = readySet.ComputeReady(statuses);

                foreach (var jobId in ready)
                {
                    if (entry.Paused)
                    {
                        break;
                    }

                    var monoMs = this.clock.MonotonicMilliseconds;
                    if (!this.channels.TryDedup(planId, jobId, "ready", monoMs))
                    {
                        continue;
                    }

                    this.jobToPlan[jobId.ToString()] = planId.ToString();

                    await this.bus.PublishAsync(
                        new JobReadyEvent
                        {
                            PlanId = planId,
                            JobId = jobId,
                            Predecessors = graph.GetPredecessors(jobId.ToString())
                                .Select(s => JobId.Parse(s))
                                .ToImmutableArray(),
                            At = this.clock.UtcNow,
                        },
                        ct).ConfigureAwait(false);

                    await this.channels.ReadyChannel.Writer.WriteAsync(jobId, linked.Token).ConfigureAwait(false);
                }
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            this.logger.LogError(ex, "Watch for plan {PlanId} failed.", planId);
        }
    }

    private async Task RunDispatchLoopAsync(CancellationToken ct)
    {
        try
        {
            await foreach (var jobId in this.channels.ReadyChannel.Reader.ReadAllAsync(ct).ConfigureAwait(false))
            {
                if (!this.jobToPlan.TryGetValue(jobId.ToString(), out var planIdStr) ||
                    !this.plans.TryGetValue(planIdStr, out var planEntry))
                {
                    continue;
                }

                if (planEntry.Paused)
                {
                    continue;
                }

                _ = Task.Run(() => this.AdmitAndDispatchAsync(planEntry.PlanId, jobId, planEntry, ct), ct);
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            this.logger.LogError(ex, "Dispatch loop failed.");
        }
    }

    private async Task AdmitAndDispatchAsync(PlanId planId, JobId jobId, PlanEntry entry, CancellationToken ct)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, entry.PlanCts.Token);

        try
        {
            await this.globalSemaphore.WaitAsync(linked.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return;
        }

        var principal = entry.Principal;
        bool semaphoreReleased = false;

        try
        {
            UserAdmission? userAdmission = null;
            HostAdmission? hostAdmission = null;

            try
            {
                userAdmission = await this.userConc.AcquireAsync(principal, jobId, linked.Token).ConfigureAwait(false);
                hostAdmission = await this.hostConc.AcquireAsync(principal, jobId, linked.Token).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                this.logger.LogWarning(ex, "Admission failed for job {JobId}; re-queuing.", jobId);

                if (userAdmission is not null)
                {
                    await userAdmission.DisposeAsync().ConfigureAwait(false);
                }

                _ = this.globalSemaphore.Release();
                semaphoreReleased = true;
                await this.channels.ReadyChannel.Writer.WriteAsync(jobId, ct).ConfigureAwait(false);
                return;
            }

            await using (userAdmission)
            await using (hostAdmission)
            {
                await this.bus.PublishAsync(
                    new JobScheduledEvent { PlanId = planId, JobId = jobId, At = this.clock.UtcNow },
                    ct).ConfigureAwait(false);

                await this.phaseExec.ExecuteAsync(planId, jobId, linked.Token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            this.logger.LogError(ex, "Dispatch failed for job {JobId}.", jobId);
        }
        finally
        {
            if (!semaphoreReleased)
            {
                _ = this.globalSemaphore.Release();
            }
        }
    }

    /// <summary>Tracks runtime state for a single plan being scheduled.</summary>
    private sealed class PlanEntry
    {
        private volatile bool paused;

        public PlanEntry(PlanId planId)
        {
            this.PlanId = planId;
            this.PlanCts = new CancellationTokenSource();
            this.Principal = new AuthContext
            {
                PrincipalId = planId.ToString(),
                DisplayName = planId.ToString(),
                Scopes = ImmutableArray<string>.Empty,
            };
        }

        public PlanId PlanId { get; }

        public CancellationTokenSource PlanCts { get; }

        public AuthContext Principal { get; }

        public bool Paused { get => this.paused; set => this.paused = value; }
    }
}
