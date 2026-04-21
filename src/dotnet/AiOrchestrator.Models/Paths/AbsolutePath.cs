// <copyright file="AbsolutePath.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.IO;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Models.Paths;

/// <summary>Represents a validated absolute filesystem path.</summary>
public readonly record struct AbsolutePath
{
    /// <summary>Initializes a new instance of the <see cref="AbsolutePath"/> struct.</summary>
    /// <param name="value">The rooted filesystem path to wrap.</param>
    /// <exception cref="ArgumentException">
    /// Thrown when <paramref name="value"/> is null, empty, or not a rooted path.
    /// </exception>
    public AbsolutePath(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            throw new ArgumentException("Path must not be null or empty.", nameof(value));
        }

        if (!Path.IsPathRooted(value))
        {
            throw new ArgumentException($"Path must be absolute (rooted). Got: '{value}'", nameof(value));
        }


        this.Value = value;
    }

    /// <summary>Gets the raw path value.</summary>
    public string Value { get; }

    /// <summary>Combines this path with a relative path.</summary>
    /// <param name="rel">The relative segment to append.</param>
    /// <returns>A new <see cref="AbsolutePath"/> formed by joining this path with <paramref name="rel"/>.</returns>
    public AbsolutePath Combine(RelativePath rel) => new(Path.Combine(this.Value, rel.Value));

    /// <inheritdoc/>
    public override string ToString() => this.Value;
}
