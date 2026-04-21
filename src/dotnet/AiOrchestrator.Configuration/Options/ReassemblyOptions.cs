// <copyright file="ReassemblyOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.ComponentModel.DataAnnotations;

namespace AiOrchestrator.Configuration.Options;

/// <summary>Event-log reassembly tuning (§3.31.2.5 EventLog:Reassembly:*).</summary>
public sealed class ReassemblyOptions
{
    /// <summary>Gets or sets the maximum number of bytes the reassembly buffer may grow to.</summary>
    [Range(64 * 1024, int.MaxValue)]
    public int MaxBufferBytes { get; set; } = 16 * 1024 * 1024;

    /// <summary>Gets or sets the milliseconds after which an incomplete reassembly is abandoned.</summary>
    [Range(100, 60_000)]
    public int TimeoutMs { get; set; } = 5_000;
}
