// <copyright file="PhaseExecutionException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Plan.PhaseExec;

/// <summary>
/// Thrown by phase classes to signal a classified failure that <see cref="PhaseExecutor"/>
/// can route through <see cref="HealOrResumeStrategy"/>. The <see cref="Kind"/> determines
/// whether the failure is auto-healed, phase-resumed, or terminal.
/// </summary>
[Serializable]
public sealed class PhaseExecutionException : Exception
{
    /// <summary>Initializes a new instance of the <see cref="PhaseExecutionException"/> class.</summary>
    /// <param name="kind">The classification of the failure.</param>
    /// <param name="phase">The phase in which the failure occurred.</param>
    /// <param name="message">A human-readable description of the failure.</param>
    /// <param name="inner">An optional inner exception.</param>
    public PhaseExecutionException(PhaseFailureKind kind, JobPhase phase, string message, Exception? inner = null)
        : base(message, inner)
    {
        this.Kind = kind;
        this.Phase = phase;
    }

    /// <summary>Gets the classification of the failure.</summary>
    public PhaseFailureKind Kind { get; }

    /// <summary>Gets the phase in which the failure occurred.</summary>
    public JobPhase Phase { get; }
}
