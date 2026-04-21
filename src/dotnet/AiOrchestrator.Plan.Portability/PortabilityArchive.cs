// <copyright file="PortabilityArchive.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using AiOrchestrator.Plan.Models;
using PlanModel = AiOrchestrator.Plan.Models.Plan;

namespace AiOrchestrator.Plan.Portability;

/// <summary>In-memory representation of a loaded <c>.aioplan</c> archive.</summary>
public sealed class PortabilityArchive
{
    /// <summary>Gets the schema version declared in the manifest.</summary>
    public required Version SchemaVersion { get; init; }

    /// <summary>Gets the UTC time the bundle was produced.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets the AIO version recorded at production time.</summary>
    public required string AioVersion { get; init; }

    /// <summary>Gets the deserialized plan definition contained in the archive.</summary>
    public required PlanModel Plan { get; init; }

    /// <summary>Gets the auxiliary artifact files stored alongside the plan, keyed by archive-relative path.</summary>
    public required ImmutableDictionary<string, byte[]> Artifacts { get; init; }
}
