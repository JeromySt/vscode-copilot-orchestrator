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
    /// <returns>A new <see cref="JobId"/> with a randomly generated value.</returns>
    public static JobId New() => new(Guid.NewGuid());

    /// <summary>Parses a job identifier from its string representation.</summary>
    /// <param name="s">The string to parse, expected in the format <c>job_&lt;guid&gt;</c>.</param>
    /// <returns>The parsed <see cref="JobId"/>.</returns>
    /// <exception cref="FormatException">Thrown when <paramref name="s"/> does not match the expected format.</exception>
    public static JobId Parse(string s)
    {
        if (!TryParse(s, out var id))
        {
            throw new FormatException($"Invalid JobId format: '{s}'");
        }

        return id;
    }

    /// <summary>Tries to parse a job identifier from its string representation.</summary>
    /// <param name="s">The string to parse.</param>
    /// <param name="id">When successful, contains the parsed <see cref="JobId"/>; otherwise the default value.</param>
    /// <returns><see langword="true"/> if parsing succeeded; otherwise <see langword="false"/>.</returns>
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
    public override string ToString() => $"{Prefix}{this.Value:N}";
}
