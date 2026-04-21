// <copyright file="DefaultPlanSerializer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Plan.Models;

/// <summary>Default implementation of <see cref="IPlanSerializer"/> backed by <see cref="PlanJson"/>.</summary>
public sealed class DefaultPlanSerializer : IPlanSerializer
{
    /// <inheritdoc/>
    public Plan? Deserialize(string json) => PlanJson.Deserialize(json);

    /// <inheritdoc/>
    public string Serialize(Plan plan) => PlanJson.Serialize(plan);
}
