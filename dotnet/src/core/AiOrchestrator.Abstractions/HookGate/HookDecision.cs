// <copyright file="HookDecision.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Abstractions.HookGate;

/// <summary>The outcome of a hook gate authorization check.</summary>
public enum HookDecision
{
    /// <summary>The action is permitted to proceed.</summary>
    Allow,

    /// <summary>The action is rejected and must not proceed.</summary>
    Deny,

    /// <summary>The action requires explicit user confirmation before proceeding.</summary>
    RequireConfirmation,
}
