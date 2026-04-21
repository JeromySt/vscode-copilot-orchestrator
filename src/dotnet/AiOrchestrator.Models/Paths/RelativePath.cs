// <copyright file="RelativePath.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Models.Paths;

/// <summary>A validated relative filesystem path that refuses to be rooted.</summary>
public readonly record struct RelativePath
{
    /// <summary>Initializes a new instance of the <see cref="RelativePath"/> struct.</summary>
    /// <param name="value">The relative path string.</param>
    /// <exception cref="ArgumentException">The value is a rooted path.</exception>
    public RelativePath(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || Path.IsPathRooted(value))
        {
            throw new ArgumentException("RelativePath must not be a rooted path.", nameof(value));
        }

        this.Value = value;
    }

    /// <summary>Gets the underlying path string.</summary>
    public string Value { get; }

    /// <inheritdoc/>
    public override string ToString() => this.Value;
}
