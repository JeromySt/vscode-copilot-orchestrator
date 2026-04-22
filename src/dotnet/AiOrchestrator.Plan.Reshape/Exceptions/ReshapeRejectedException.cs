// <copyright file="ReshapeRejectedException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;

namespace AiOrchestrator.Plan.Reshape;

/// <summary>
/// Raised when <see cref="PlanReshaper.ApplyAsync"/> rejects a batch during pre-application validation
/// (RS-TXN-1). No mutations have been persisted when this exception is thrown.
/// </summary>
#pragma warning disable CA1032 // Exception parameterless ctor
public sealed class ReshapeRejectedException : Exception
#pragma warning restore CA1032
{
    /// <summary>Gets the per-operation failure diagnostics.</summary>
    public required ImmutableArray<OperationResult> Failures { get; init; }
}
