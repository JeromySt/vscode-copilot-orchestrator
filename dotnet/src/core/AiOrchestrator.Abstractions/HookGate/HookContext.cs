// <copyright file="HookContext.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Abstractions.HookGate;

/// <summary>Contextual information passed to the hook gate when a tool invocation needs authorization.</summary>
public sealed record HookContext
{
    /// <summary>Gets the principal performing the action being gated.</summary>
    public required AuthContext Principal { get; init; }

    /// <summary>Gets the plan associated with the action, if any.</summary>
    public PlanId? PlanId { get; init; }

    /// <summary>Gets the job associated with the action, if any.</summary>
    public JobId? JobId { get; init; }

    /// <summary>Gets the tool or capability identifier being requested (e.g., <c>fs.write</c>, <c>net.http</c>).</summary>
    public required string Capability { get; init; }

    /// <summary>Gets the resource target of the action, when applicable (e.g., a path or URL).</summary>
    public string? Target { get; init; }

    /// <summary>Gets the working directory in which the action will run, when applicable.</summary>
    public AbsolutePath? WorkingDirectory { get; init; }

    /// <summary>Gets a free-form reason or human-readable description for the action.</summary>
    public string? Reason { get; init; }
}
