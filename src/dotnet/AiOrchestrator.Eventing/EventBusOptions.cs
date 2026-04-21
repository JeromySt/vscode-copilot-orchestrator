// <copyright file="EventBusOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.ComponentModel.DataAnnotations;

namespace AiOrchestrator.Eventing;

/// <summary>Configuration for <see cref="EventBus"/>.</summary>
public sealed record EventBusOptions
{
    /// <summary>Gets the maximum number of in-flight events buffered per subscription.</summary>
    [Range(1, 1_000_000)]
    public int PerSubscriptionBufferSize { get; init; } = 1024;

    /// <summary>Gets the policy applied when a subscription's channel is full.</summary>
    public BackpressureMode Backpressure { get; init; } = BackpressureMode.Wait;

    /// <summary>Gets a value indicating whether to enable dedup-by-event-key.</summary>
    public bool EnableDedup { get; init; }

    /// <summary>Gets the dedup deduplication window.</summary>
    public TimeSpan DedupWindow { get; init; } = TimeSpan.FromSeconds(5);
}
