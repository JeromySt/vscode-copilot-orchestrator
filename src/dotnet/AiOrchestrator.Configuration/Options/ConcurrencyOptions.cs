// <copyright file="ConcurrencyOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.ComponentModel.DataAnnotations;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Configuration.Options;

/// <summary>Concurrency policy options (§3.31.4.3 Concurrency:HostFairness).</summary>
[OptionsValidator]
public sealed partial class ConcurrencyOptions : IValidateOptions<ConcurrencyOptions>
{
    /// <summary>Gets or sets the fairness strategy used when allocating slots across hosts.</summary>
    public HostFairnessKind HostFairness { get; set; } = HostFairnessKind.Proportional;

    /// <summary>Gets or sets the maximum number of parallel jobs across the host.</summary>
    [Range(1, 1024)]
    public int MaxParallelJobsHost { get; set; } = 8;

    /// <summary>Gets or sets the maximum number of parallel jobs per user.</summary>
    [Range(1, 256)]
    public int MaxParallelJobsPerUser { get; set; } = 4;
}
