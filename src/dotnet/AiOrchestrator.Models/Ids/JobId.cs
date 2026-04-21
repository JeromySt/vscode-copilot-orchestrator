// <copyright file="JobId.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Models.Ids;

/// <summary>Strongly-typed identifier for a job.</summary>
public readonly record struct JobId(Guid Value)
{
    private const string Prefix = "job_";

    /// <summary>Creates a new random job identifier.</summary>
    public static JobId New() => new(Guid.NewGuid());

    /// <summary>Parses a job identifier from its string representation.</summary>
    public static JobId Parse(string s)
    {
        if (!TryParse(s, out var id))
        {
            throw new FormatException($"Invalid JobId format: '{s}'");
        }

        return id;
    }

    /// <summary>Tries to parse a job identifier from its string representation.</summary>
    public static bool TryParse(string s, out JobId id)
    {
        id = default;
        if (s == null || !s.StartsWith(Prefix, StringComparison.Ordinal))
        {
            return false;
        }

        if (Guid.TryParseExact(s.Substring(Prefix.Length), "N", out var guid))
        {
            id = new JobId(guid);
            return true;
        }

        return false;
    }

    /// <inheritdoc/>
    public override string ToString() => $"{Prefix}{Value:N}";
}
