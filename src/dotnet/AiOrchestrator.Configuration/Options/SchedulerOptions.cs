// <copyright file="SchedulerOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using Microsoft.Extensions.Options;

namespace AiOrchestrator.Configuration.Options;

/// <summary>Scheduler options (§3.31.2.4 Scheduler:Channel:Bounds).</summary>
[OptionsValidator]
public sealed partial class SchedulerOptions : IValidateOptions<SchedulerOptions>
{
    /// <summary>Gets or sets the channel bounds for the scheduler.</summary>
    [ValidateObjectMembers]
    public ChannelBoundsOptions Channel { get; set; } = new();
}
