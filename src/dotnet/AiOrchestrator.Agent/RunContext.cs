// <copyright file="RunContext.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Agent;

/// <summary>Identifies the job/run/principal under which an agent invocation executes.</summary>
public sealed record RunContext
{
    /// <summary>Gets the owning job identifier.</summary>
    public required JobId JobId { get; init; }

    /// <summary>Gets the run identifier within the job.</summary>
    public required RunId RunId { get; init; }

    /// <summary>Gets the authenticated principal that requested the run.</summary>
    public required AuthContext Principal { get; init; }
}
