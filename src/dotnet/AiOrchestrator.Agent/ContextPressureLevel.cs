// <copyright file="ContextPressureLevel.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Agent;

/// <summary>Rolling context-window pressure levels (INV-7).</summary>
public enum ContextPressureLevel
{
    /// <summary>No pressure measured yet.</summary>
    None,

    /// <summary>Context usage has crossed the rising threshold (0.60).</summary>
    Rising,

    /// <summary>Context usage has crossed the high threshold (0.80).</summary>
    High,

    /// <summary>Context usage has crossed the critical threshold (0.92).</summary>
    Critical,
}
