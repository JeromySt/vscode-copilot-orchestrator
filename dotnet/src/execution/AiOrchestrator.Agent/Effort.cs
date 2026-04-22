// <copyright file="Effort.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Agent;

/// <summary>Reasoning-effort knob passed to agents that support it (INV-8).</summary>
public enum Effort
{
    /// <summary>Lowest reasoning budget.</summary>
    Low,

    /// <summary>Default reasoning budget.</summary>
    Medium,

    /// <summary>Increased reasoning budget.</summary>
    High,

    /// <summary>Extreme reasoning budget. Only supported by a subset of runners (see INV-8).</summary>
    Xhigh,
}
