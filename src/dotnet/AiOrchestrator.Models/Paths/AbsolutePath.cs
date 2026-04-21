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
    /// <summary>Gets the raw path value.</summary>
    public string Value { get; }

    /// <summary>Initializes a new absolute path, throwing if the path is not rooted.</summary>
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

        Value = value;
    }

    /// <summary>Combines this path with a relative path.</summary>
    public AbsolutePath Combine(RelativePath rel) => new(Path.Combine(Value, rel.Value));

    /// <inheritdoc/>
    public override string ToString() => Value;
}
