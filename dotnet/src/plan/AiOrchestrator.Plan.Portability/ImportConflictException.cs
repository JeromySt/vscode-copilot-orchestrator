// <copyright file="ImportConflictException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Models;

namespace AiOrchestrator.Plan.Portability;

/// <summary>Thrown on import when the archived plan id collides with an existing plan and the policy forbids continuation (PORT-5).</summary>
public sealed class ImportConflictException : Exception
{
    /// <summary>Initializes a new instance of the <see cref="ImportConflictException"/> class.</summary>
    public ImportConflictException()
        : base("An existing plan with the same id prevents import under the configured conflict policy.")
    {
    }

    /// <summary>Initializes a new instance of the <see cref="ImportConflictException"/> class with a message.</summary>
    /// <param name="message">The message.</param>
    public ImportConflictException(string message)
        : base(message)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="ImportConflictException"/> class with a message and inner exception.</summary>
    /// <param name="message">The message.</param>
    /// <param name="innerException">The inner exception.</param>
    public ImportConflictException(string message, Exception innerException)
        : base(message, innerException)
    {
    }

    /// <summary>Gets the id of the existing plan that blocked the import.</summary>
    public required PlanId ExistingPlanId { get; init; }

    /// <summary>Gets the status of the existing plan at the moment the conflict was detected.</summary>
    public required PlanStatus ExistingStatus { get; init; }
}
