// <copyright file="ModelTier.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Agent;

/// <summary>Semantic model tier, resolved to a runner-specific model at invocation time.</summary>
public enum ModelTier
{
    /// <summary>Lowest latency / cost tier.</summary>
    Fast,

    /// <summary>Default balanced tier.</summary>
    Standard,

    /// <summary>Highest capability tier.</summary>
    Premium,
}
