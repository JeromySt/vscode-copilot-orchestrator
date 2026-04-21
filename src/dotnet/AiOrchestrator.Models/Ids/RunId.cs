// <copyright file="RunId.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Models.Ids;

/// <summary>Strongly-typed identifier for a run. Prefix: <c>run_</c>.</summary>
public readonly record struct RunId
{
    /// <summary>Initializes a new instance of the <see cref="RunId"/> struct.</summary>
    /// <param name="value">The underlying GUID value.</param>
    public RunId(Guid value)
    {
        Value = value;
    }

    /// <summary>Gets the underlying GUID value.</summary>
    public Guid Value { get; }

    /// <summary>Creates a new <see cref="RunId"/> with a randomly generated GUID.</summary>
    /// <returns>A new unique <see cref="RunId"/>.</returns>
    public static RunId New() => new(Guid.NewGuid());

    /// <summary>Parses a string of the form <c>run_&lt;N&gt;</c> into a <see cref="RunId"/>.</summary>
    /// <param name="s">The string to parse.</param>
    /// <returns>The parsed <see cref="RunId"/>.</returns>
    /// <exception cref="FormatException">The string is not a valid run ID.</exception>
    public static RunId Parse(string s)
    {
        if (!TryParse(s, out var id))
        {
            throw new FormatException($"Invalid RunId: '{s}'. Expected format: run_<guid>");
        }

        return id;
    }

    /// <summary>Attempts to parse a string into a <see cref="RunId"/>.</summary>
    /// <param name="s">The string to parse.</param>
    /// <param name="id">The parsed <see cref="RunId"/> if successful.</param>
    /// <returns><see langword="true"/> if parsing succeeded; otherwise <see langword="false"/>.</returns>
    public static bool TryParse(string s, out RunId id)
    {
        if (s.StartsWith("run_", StringComparison.Ordinal)
            && Guid.TryParseExact(s["run_".Length..], "N", out var guid))
        {
            id = new RunId(guid);
            return true;
        }

        id = default;
        return false;
    }

    /// <inheritdoc/>
    public override string ToString() => $"run_{Value:N}";
}
