// <copyright file="PlanOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.ComponentModel.DataAnnotations;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Configuration.Options;

/// <summary>Plan-persistence options (§3.31.3.3 Plan:DiskCapMb).</summary>
[OptionsValidator]
public sealed partial class PlanOptions : IValidateOptions<PlanOptions>
{
    /// <summary>Gets or sets the maximum megabytes the plan store may occupy on disk.</summary>
    [Range(1, int.MaxValue)]
    public int DiskCapMb { get; set; } = 8_192;
}
