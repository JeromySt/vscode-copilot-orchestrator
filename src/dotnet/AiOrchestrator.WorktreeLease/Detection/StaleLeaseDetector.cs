// <copyright file="StaleLeaseDetector.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.WorktreeLease.Cas;
using AiOrchestrator.WorktreeLease.Events;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.WorktreeLease.Detection;

/// <summary>
/// Polls a worktree's lease file at <see cref="LeaseOptions.StaleCheckInterval"/> and
/// publishes a <see cref="WorktreeLeaseStolen"/> event if the stored token differs from
/// the token the holder expects (INV-6).
/// </summary>
public sealed class StaleLeaseDetector : IAsyncDisposable
{
    private readonly CasLeaseStore store;
    private readonly IClock clock;
    private readonly IEventBus bus;
    private readonly IOptionsMonitor<LeaseOptions> opts;
    private readonly CancellationTokenSource cts = new();

    private Task? loopTask;
    private int disposed;

    /// <summary>Initializes a new instance of the <see cref="StaleLeaseDetector"/> class.</summary>
    /// <param name="fs">File system abstraction.</param>
    /// <param name="clock">Clock.</param>
    /// <param name="bus">Event bus on which <see cref="WorktreeLeaseStolen"/> is published.</param>
    /// <param name="opts">Options monitor providing the polling interval.</param>
    public StaleLeaseDetector(IFileSystem fs, IClock clock, IEventBus bus, IOptionsMonitor<LeaseOptions> opts)
    {
        this.store = new CasLeaseStore(fs, clock);
        this.clock = clock;
        this.bus = bus;
        this.opts = opts;
    }

    /// <summary>Starts the polling loop for <paramref name="worktree"/>.</summary>
    /// <param name="worktree">The worktree whose lease is being monitored.</param>
    /// <param name="expectedToken">The token the holder believes it currently owns.</param>
    /// <param name="ct">External cancellation token.</param>
    /// <returns>A completed <see cref="ValueTask"/>; the monitoring loop runs in the background.</returns>
    public ValueTask StartAsync(AbsolutePath worktree, FencingToken expectedToken, CancellationToken ct)
    {
        var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(this.cts.Token, ct);
        this.loopTask = Task.Run(() => this.LoopAsync(worktree, expectedToken, linkedCts.Token), linkedCts.Token);
        return ValueTask.CompletedTask;
    }

    /// <inheritdoc/>
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref this.disposed, 1) != 0)
        {
            return;
        }

        try
        {
            await this.cts.CancelAsync().ConfigureAwait(false);
            if (this.loopTask is not null)
            {
                try
                {
                    await this.loopTask.ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    // expected
                }
            }
        }
        finally
        {
            this.cts.Dispose();
        }
    }

    private async Task LoopAsync(AbsolutePath worktree, FencingToken expectedToken, CancellationToken ct)
    {
        var leaseFile = CasLeaseStore.LeaseFileFor(worktree);

        while (!ct.IsCancellationRequested)
        {
            var interval = this.opts.CurrentValue.StaleCheckInterval;
            try
            {
                await Task.Delay(interval, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }

            LeaseFileContent? content;
            try
            {
                content = await this.store.ReadAsync(leaseFile, ct).ConfigureAwait(false);
            }
            catch (IOException)
            {
                // transient — retry on next tick
                continue;
            }

            if (content is null)
            {
                continue;
            }

            if (content.Token.Value != expectedToken.Value)
            {
                var evt = new WorktreeLeaseStolen
                {
                    Worktree = worktree,
                    ExpectedToken = expectedToken,
                    ObservedToken = content.Token,
                    At = this.clock.UtcNow,
                };
                await this.bus.PublishAsync(evt, ct).ConfigureAwait(false);
                return; // once reported, detector for this holder stops
            }
        }
    }
}
