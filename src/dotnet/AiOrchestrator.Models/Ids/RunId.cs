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
    public static RunId New() => new(Guid.NewGuid());

    /// <summary>Parses a run identifier from its string representation.</summary>
    public static RunId Parse(string s)
    {
        if (!TryParse(s, out var id))
        {
            throw new FormatException($"Invalid RunId format: '{s}'");
        }

        return id;
    }

    /// <summary>Tries to parse a run identifier from its string representation.</summary>
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
    public override string ToString() => $"{Prefix}{Value:N}";
}
