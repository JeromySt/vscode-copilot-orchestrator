// <copyright file="RelativePath.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.IO;

namespace AiOrchestrator.Models.Paths;

/// <summary>Represents a relative filesystem path that cannot be rooted.</summary>
public readonly record struct RelativePath
{
    /// <summary>Gets the raw path value.</summary>
    public string Value { get; }

    /// <summary>Initializes a new relative path, throwing if rooted.</summary>
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

        Value = value;
    }

    /// <inheritdoc/>
    public override string ToString() => Value;
}
