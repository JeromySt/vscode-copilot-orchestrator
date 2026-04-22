// <copyright file="HostFairnessKind.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Configuration.Options;

/// <summary>Determines how available concurrency slots are distributed across hosts.</summary>
public enum HostFairnessKind
{
    /// <summary>Each host is served in strict round-robin order.</summary>
    StrictRoundRobin,

    /// <summary>Slots are distributed proportionally to host load.</summary>
    Proportional,
}
