// <copyright file="ChannelBoundsOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.ComponentModel.DataAnnotations;

namespace AiOrchestrator.Configuration.Options;

/// <summary>Bounded-channel sizing and overflow policy (§3.31.2.4).</summary>
public sealed class ChannelBoundsOptions
{
    /// <summary>Gets or sets the maximum number of items the channel can hold before the overflow policy applies.</summary>
    [Range(1, 1_000_000)]
    public int Capacity { get; set; } = 1024;

    /// <summary>Gets or sets how the channel behaves when it is full.</summary>
    [Required]
    public ChannelFullMode FullMode { get; set; } = ChannelFullMode.Wait;

    /// <summary>Gets or sets a value indicating whether duplicate items are deduplicated before entering the channel.</summary>
    public bool Dedup { get; set; } = true;
}
