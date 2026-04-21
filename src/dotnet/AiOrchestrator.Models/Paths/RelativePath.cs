// <copyright file="RelativePath.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.IO;

namespace AiOrchestrator.Models.Paths;

/// <summary>Represents a relative filesystem path that cannot be rooted.</summary>
public readonly record struct RelativePath
{
    /// <summary>Initializes a new instance of the <see cref="RelativePath"/> struct.</summary>
    /// <param name="value">The relative path value to wrap.</param>
    /// <exception cref="ArgumentException">
    /// Thrown when <paramref name="value"/> is null, empty, or is a rooted path.
    /// </exception>
    public RelativePath(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            throw new ArgumentException("Path must not be null or empty.", nameof(value));
        }

        if (Path.IsPathRooted(value))
        {
            throw new ArgumentException($"RelativePath must not be rooted. Got: '{value}'", nameof(value));
        }


        this.Value = value;
    }

    /// <summary>Gets the raw path value.</summary>
    public string Value { get; }

    /// <inheritdoc/>
    public override string ToString() => this.Value;
}
