// <copyright file="JobId.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Models.Ids;

/// <summary>Strongly-typed identifier for a job. Prefix: <c>job_</c>.</summary>
public readonly record struct JobId
{
    /// <summary>Initializes a new instance of the <see cref="JobId"/> struct.</summary>
    /// <param name="value">The underlying GUID value.</param>
    public JobId(Guid value) => Value = value;

    /// <summary>Gets the underlying GUID value.</summary>
    public Guid Value { get; }

    /// <summary>Creates a new <see cref="JobId"/> with a randomly generated GUID.</summary>
    /// <returns>A new unique <see cref="JobId"/>.</returns>
    public static JobId New() => new(Guid.NewGuid());

    /// <summary>Parses a string of the form <c>job_&lt;N&gt;</c> into a <see cref="JobId"/>.</summary>
    /// <param name="s">The string to parse.</param>
    /// <returns>The parsed <see cref="JobId"/>.</returns>
    /// <exception cref="FormatException">The string is not a valid job ID.</exception>
    public static JobId Parse(string s)
    {
        if (!TryParse(s, out var id))
        {
            throw new FormatException($"Invalid JobId: '{s}'. Expected format: job_<guid>");
        }

        return id;
    }

    /// <summary>Attempts to parse a string into a <see cref="JobId"/>.</summary>
    /// <param name="s">The string to parse.</param>
    /// <param name="id">The parsed <see cref="JobId"/> if successful.</param>
    /// <returns><see langword="true"/> if parsing succeeded; otherwise <see langword="false"/>.</returns>
    public static bool TryParse(string s, out JobId id)
    {
        if (s.StartsWith("job_", StringComparison.Ordinal)
            && Guid.TryParseExact(s["job_".Length..], "N", out var guid))
        {
            id = new JobId(guid);
            return true;
        }

        id = default;
        return false;
    }

    /// <inheritdoc/>
    public override string ToString() => $"job_{Value:N}";
}
