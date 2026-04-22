// <copyright file="DedupCache.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Concurrent;
using AiOrchestrator.Abstractions.Time;

namespace AiOrchestrator.Eventing;

/// <summary>
/// Time-bounded cache that detects duplicate <c>(EventType, DedupKey)</c> publishes within a sliding window.
/// Implements CONC-CHAN-2 dedup-by-event-key. Lock-free for the hot path.
/// </summary>
internal sealed class DedupCache
{
    private readonly ConcurrentDictionary<DedupKey, DateTimeOffset> entries = new();
    private readonly IClock clock;

    /// <summary>Initializes a new instance of the <see cref="DedupCache"/> class.</summary>
    /// <param name="clock">The clock used for window computations.</param>
    public DedupCache(IClock clock)
    {
        this.clock = clock;
    }

    /// <summary>
    /// Attempts to register a <c>(eventType, key)</c> pair. Returns <see langword="true"/>
    /// when the pair is fresh (caller should publish). Returns <see langword="false"/>
    /// when the pair has been seen within <paramref name="window"/> (caller should drop).
    /// </summary>
    /// <param name="eventType">The CLR type of the event.</param>
    /// <param name="key">The dedup key extracted from the event.</param>
    /// <param name="window">The dedup window.</param>
    /// <returns><see langword="true"/> if the event is fresh.</returns>
    public bool TryRegister(Type eventType, string? key, TimeSpan window)
    {
        if (key is null)
        {
            return true;
        }

        var dedupKey = new DedupKey(eventType, key);
        var now = this.clock.UtcNow;

        // Periodic eviction of stale entries (cheap amortised cost).
        if ((this.entries.Count & 0x3F) == 0)
        {
            this.EvictExpired(now, window);
        }

        while (true)
        {
            if (this.entries.TryAdd(dedupKey, now))
            {
                return true;
            }

            if (!this.entries.TryGetValue(dedupKey, out var existing))
            {
                continue;
            }

            if ((now - existing) <= window)
            {
                return false;
            }

            if (this.entries.TryUpdate(dedupKey, now, existing))
            {
                return true;
            }
        }
    }

    private void EvictExpired(DateTimeOffset now, TimeSpan window)
    {
        foreach (var kv in this.entries)
        {
            if ((now - kv.Value) > window)
            {
                _ = this.entries.TryRemove(kv);
            }
        }
    }

    private readonly record struct DedupKey(Type EventType, string Key);
}
