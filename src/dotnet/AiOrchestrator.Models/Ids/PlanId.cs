// <copyright file="PlanId.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Models.Ids;

/// <summary>Strongly-typed identifier for a plan.</summary>
public readonly record struct PlanId(Guid Value)
{
    private const string Prefix = "plan_";

    /// <summary>Creates a new random plan identifier.</summary>
    /// <returns>A new <see cref="PlanId"/> with a randomly generated value.</returns>
    public static PlanId New() => new(Guid.NewGuid());

    /// <summary>Parses a plan identifier from its string representation.</summary>
    /// <param name="s">The string to parse, expected in the format <c>plan_&lt;guid&gt;</c>.</param>
    /// <returns>The parsed <see cref="PlanId"/>.</returns>
    /// <exception cref="FormatException">Thrown when <paramref name="s"/> does not match the expected format.</exception>
    public static PlanId Parse(string s)
    {
        if (!TryParse(s, out var id))
        {
            throw new FormatException($"Invalid PlanId format: '{s}'");
        }

        return id;
    }

    /// <summary>Tries to parse a plan identifier from its string representation.</summary>
    /// <param name="s">The string to parse.</param>
    /// <param name="id">When successful, contains the parsed <see cref="PlanId"/>; otherwise the default value.</param>
    /// <returns><see langword="true"/> if parsing succeeded; otherwise <see langword="false"/>.</returns>
    public static bool TryParse(string s, out PlanId id)
    {
        id = default;
        if (s == null || !s.StartsWith(Prefix, StringComparison.Ordinal))
        {
            return false;
        }

        if (Guid.TryParseExact(s.Substring(Prefix.Length), "N", out var guid))
        {
            id = new PlanId(guid);
            return true;
        }

        return false;
    }

    /// <inheritdoc/>
    public override string ToString() => $"{Prefix}{this.Value:N}";
}
