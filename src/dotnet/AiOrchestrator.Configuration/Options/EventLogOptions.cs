// <copyright file="EventLogOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using Microsoft.Extensions.Options;

namespace AiOrchestrator.Configuration.Options;

/// <summary>Event-log options (§3.31.2.5).</summary>
[OptionsValidator]
public sealed partial class EventLogOptions : IValidateOptions<EventLogOptions>
{
    /// <summary>Gets or sets the reassembly buffer configuration.</summary>
    [ValidateObjectMembers]
    public ReassemblyOptions Reassembly { get; set; } = new();
}
