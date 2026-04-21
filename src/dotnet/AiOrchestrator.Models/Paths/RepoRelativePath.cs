// <copyright file="RepoRelativePath.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Models.Paths;

/// <summary>A validated repository-relative path that refuses <c>..</c> traversal segments.</summary>
public readonly record struct RepoRelativePath
{
    /// <summary>Initializes a new instance of the <see cref="RepoRelativePath"/> struct.</summary>
    /// <param name="value">The repository-relative path string.</param>
    /// <exception cref="ArgumentException">The value contains parent-traversal segments or is rooted.</exception>
    public RepoRelativePath(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || Path.IsPathRooted(value))
        {
            throw new ArgumentException("RepoRelativePath must not be a rooted path.", nameof(value));
        }

        var normalized = Path.GetFullPath(Path.Combine(".", value));
        if (!normalized.StartsWith(Path.GetFullPath("."), StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException("RepoRelativePath must not contain parent-traversal '..' segments.", nameof(value));
        }

        this.Value = value;
    }

    /// <summary>Gets the underlying path string.</summary>
    public string Value { get; }

    /// <inheritdoc/>
    public override string ToString() => this.Value;
}
