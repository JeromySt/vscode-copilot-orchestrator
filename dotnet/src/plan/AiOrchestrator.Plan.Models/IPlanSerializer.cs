// <copyright file="IPlanSerializer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Plan.Models;

/// <summary>Converts <see cref="Plan"/> instances to and from a canonical JSON representation.</summary>
public interface IPlanSerializer
{
    /// <summary>Deserializes a <see cref="Plan"/> from its JSON representation.</summary>
    /// <param name="json">The JSON string produced by <see cref="Serialize"/>.</param>
    /// <returns>The deserialized plan, or <see langword="null"/> if <paramref name="json"/> is null or whitespace.</returns>
    Plan? Deserialize(string json);

    /// <summary>Serializes a <see cref="Plan"/> to its canonical, byte-stable JSON representation.</summary>
    /// <param name="plan">The plan to serialize.</param>
    /// <returns>An indented JSON string with alphabetically-ordered properties.</returns>
    string Serialize(Plan plan);
}
