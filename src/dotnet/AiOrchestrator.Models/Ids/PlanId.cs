// <copyright file="PlanId.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Models.Ids;

/// <summary>Strongly-typed identifier for a plan. Prefix: <c>plan_</c>.</summary>
public readonly record struct PlanId
{
    /// <summary>Initializes a new instance of the <see cref="PlanId"/> struct.</summary>
    /// <param name="value">The underlying GUID value.</param>
    public PlanId(Guid value)
    {
        Value = value;
    }

    /// <summary>Gets the underlying GUID value.</summary>
    public Guid Value { get; }

    /// <summary>Creates a new <see cref="PlanId"/> with a randomly generated GUID.</summary>
    /// <returns>A new unique <see cref="PlanId"/>.</returns>
    public static PlanId New() => new(Guid.NewGuid());

    /// <summary>Parses a string of the form <c>plan_&lt;N&gt;</c> into a <see cref="PlanId"/>.</summary>
    /// <param name="s">The string to parse.</param>
    /// <returns>The parsed <see cref="PlanId"/>.</returns>
    /// <exception cref="FormatException">The string is not a valid plan ID.</exception>
    public static PlanId Parse(string s)
    {
        if (!TryParse(s, out var id))
        {
            throw new FormatException($"Invalid PlanId: '{s}'. Expected format: plan_<guid>");
        }

        return id;
    }

    /// <summary>Attempts to parse a string into a <see cref="PlanId"/>.</summary>
    /// <param name="s">The string to parse.</param>
    /// <param name="id">The parsed <see cref="PlanId"/> if successful.</param>
    /// <returns><see langword="true"/> if parsing succeeded; otherwise <see langword="false"/>.</returns>
    public static bool TryParse(string s, out PlanId id)
    {
        if (s.StartsWith("plan_", StringComparison.Ordinal)
            && Guid.TryParseExact(s["plan_".Length..], "N", out var guid))
        {
            id = new PlanId(guid);
            return true;
        }

        id = default;
        return false;
    }

    /// <inheritdoc/>
    public override string ToString() => $"plan_{Value:N}";
}
