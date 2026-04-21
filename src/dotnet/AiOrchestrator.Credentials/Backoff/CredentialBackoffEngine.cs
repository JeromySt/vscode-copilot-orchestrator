// <copyright file="CredentialBackoffEngine.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Concurrent;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Time;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Credentials.Backoff;

/// <summary>
/// Per-URL exponential-backoff accounting (INV-7..9 / CRED-INVAL-1..3).
/// Threadsafe via a <see cref="ConcurrentDictionary{TKey, TValue}"/>; each URL has its own
/// failure counter and "backoff-engaged-until" timestamp. Engaging back-off publishes exactly
/// one <see cref="CredentialBackoffEngaged"/> per entry (INV-8).
/// </summary>
public sealed class CredentialBackoffEngine
{
    private readonly ConcurrentDictionary<string, State> states = new(StringComparer.OrdinalIgnoreCase);
    private readonly IClock clock;
    private readonly IOptionsMonitor<CredentialOptions> opts;
    private readonly IEventBus bus;

    /// <summary>Initializes a new <see cref="CredentialBackoffEngine"/>.</summary>
    /// <param name="clock">Clock used for back-off timing.</param>
    /// <param name="opts">Options monitor providing <see cref="CredentialOptions.Backoff"/>.</param>
    /// <param name="bus">Event bus used to publish <see cref="CredentialBackoffEngaged"/>.</param>
    public CredentialBackoffEngine(IClock clock, IOptionsMonitor<CredentialOptions> opts, IEventBus bus)
    {
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.opts = opts ?? throw new ArgumentNullException(nameof(opts));
        this.bus = bus ?? throw new ArgumentNullException(nameof(bus));
    }

    /// <summary>
    /// Returns <see langword="true"/> if the URL is allowed to proceed with credential retrieval;
    /// <see langword="false"/> if back-off is currently engaged, in which case <paramref name="delayUntil"/>
    /// receives the remaining wait.
    /// </summary>
    /// <param name="repoUrl">The repository URL to check.</param>
    /// <param name="delayUntil">Receives the remaining back-off delay when this method returns <see langword="false"/>.</param>
    /// <returns><see langword="true"/> to proceed; <see langword="false"/> if currently backing off.</returns>
    public bool TryEnter(Uri repoUrl, out TimeSpan delayUntil)
    {
        ArgumentNullException.ThrowIfNull(repoUrl);
        delayUntil = TimeSpan.Zero;
        var key = NormalizeKey(repoUrl);
        if (!this.states.TryGetValue(key, out var st))
        {
            return true;
        }

        var now = this.clock.UtcNow;
        if (st.BackoffUntil is { } until && now < until)
        {
            delayUntil = until - now;
            return false;
        }

        return true;
    }

    /// <summary>Records a credential-invalidation failure for the given URL. Engages back-off at the configured threshold.</summary>
    /// <param name="repoUrl">The repository URL that failed.</param>
    public void RecordFailure(Uri repoUrl)
    {
        ArgumentNullException.ThrowIfNull(repoUrl);
        var key = NormalizeKey(repoUrl);
        var backoffOpts = this.opts.CurrentValue.Backoff;

        this.states.AddOrUpdate(
            key,
            _ => new State { FailureCount = 1, BackoffUntil = null, CurrentEntry = 0 },
            (_, existing) =>
            {
                existing.FailureCount += 1;
                if (existing.FailureCount >= backoffOpts.FailuresBeforeBackoff)
                {
                    var extra = existing.FailureCount - backoffOpts.FailuresBeforeBackoff;
                    var raw = TimeSpan.FromTicks((long)(backoffOpts.InitialDelay.Ticks
                        * Math.Pow(backoffOpts.Multiplier, extra)));
                    if (raw > backoffOpts.MaxDelay)
                    {
                        raw = backoffOpts.MaxDelay;
                    }

                    existing.BackoffUntil = this.clock.UtcNow + raw;
                    existing.CurrentEntry += 1;
                    existing.LastEngagedDelay = raw;
                    existing.JustEngaged = true;
                }

                return existing;
            });

        // INV-8: publish exactly once per backoff entry.
        if (this.states.TryGetValue(key, out var afterUpdate) && afterUpdate.JustEngaged)
        {
            afterUpdate.JustEngaged = false;
            var evt = new CredentialBackoffEngaged
            {
                RepoUrl = repoUrl,
                FailureCount = afterUpdate.FailureCount,
                EffectiveDelay = afterUpdate.LastEngagedDelay,
                At = this.clock.UtcNow,
            };
            _ = this.bus.PublishAsync(evt, CancellationToken.None);
        }
    }

    /// <summary>Resets the failure counter and back-off state for the given URL (INV-9 / CRED-INVAL-3).</summary>
    /// <param name="repoUrl">The repository URL whose counter should be reset.</param>
    public void RecordSuccess(Uri repoUrl)
    {
        ArgumentNullException.ThrowIfNull(repoUrl);
        var key = NormalizeKey(repoUrl);
        _ = this.states.TryRemove(key, out _);
    }

    private static string NormalizeKey(Uri u) => u.GetLeftPart(UriPartial.Authority).ToLowerInvariant();

    private sealed class State
    {
#pragma warning disable SA1401 // internal mutable field container
        public int FailureCount;
        public DateTimeOffset? BackoffUntil;
        public int CurrentEntry;
        public TimeSpan LastEngagedDelay;
        public bool JustEngaged;
#pragma warning restore SA1401
    }
}
