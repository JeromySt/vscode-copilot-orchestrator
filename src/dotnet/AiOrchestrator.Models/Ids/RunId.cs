// <copyright file="RunId.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Models.Ids;

/// <summary>Strongly-typed identifier for a run.</summary>
public readonly record struct RunId(Guid Value)
{
    private const string Prefix = "run_";

    /// <summary>Creates a new random run identifier.</summary>
    /// <returns>A new <see cref="RunId"/> with a randomly generated value.</returns>
    public static RunId New() => new(Guid.NewGuid());

    /// <summary>Parses a run identifier from its string representation.</summary>
    /// <param name="s">The string to parse, expected in the format <c>run_&lt;guid&gt;</c>.</param>
    /// <returns>The parsed <see cref="RunId"/>.</returns>
    /// <exception cref="FormatException">Thrown when <paramref name="s"/> does not match the expected format.</exception>
    public static RunId Parse(string s)
    {
        if (!TryParse(s, out var id))
        {
            throw new FormatException($"Invalid RunId format: '{s}'");
        }

        return id;
    }

    /// <summary>Tries to parse a run identifier from its string representation.</summary>
    /// <param name="s">The string to parse.</param>
    /// <param name="id">When successful, contains the parsed <see cref="RunId"/>; otherwise the default value.</param>
    /// <returns><see langword="true"/> if parsing succeeded; otherwise <see langword="false"/>.</returns>
    public static bool TryParse(string s, out RunId id)
    {
        id = default;
        if (s == null || !s.StartsWith(Prefix, StringComparison.Ordinal))
        {
            return false;
        }

        if (Guid.TryParseExact(s.Substring(Prefix.Length), "N", out var guid))
        {
            id = new RunId(guid);
            return true;
        }

        return false;
    }

    /// <inheritdoc/>
    public override string ToString() => $"{Prefix}{this.Value:N}";
}
