// <copyright file="AbsolutePath.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Models.Paths;

/// <summary>A validated absolute filesystem path.</summary>
public readonly record struct AbsolutePath
{
    /// <summary>Initializes a new instance of the <see cref="AbsolutePath"/> struct.</summary>
    /// <param name="value">The absolute path string.</param>
    /// <exception cref="ArgumentException">The value is not a rooted path.</exception>
    public AbsolutePath(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || !Path.IsPathRooted(value))
        {
            throw new ArgumentException("AbsolutePath must be a rooted path.", nameof(value));
        }

        this.Value = value;
    }

    /// <summary>Gets the underlying path string.</summary>
    public string Value { get; }

    /// <summary>Combines this absolute path with a relative path segment.</summary>
    /// <param name="rel">The relative path to append.</param>
    /// <returns>A new <see cref="AbsolutePath"/> representing the combined path.</returns>
    public AbsolutePath Combine(RelativePath rel) => new(Path.Combine(this.Value, rel.Value));

    /// <inheritdoc/>
    public override string ToString() => this.Value;
}
