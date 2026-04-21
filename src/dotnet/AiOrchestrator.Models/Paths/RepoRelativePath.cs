// <copyright file="RepoRelativePath.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.IO;

namespace AiOrchestrator.Models.Paths;

/// <summary>Represents a path relative to the repository root, which may not traverse up with '..'.</summary>
public readonly record struct RepoRelativePath
{
    /// <summary>Gets the raw path value.</summary>
    public string Value { get; }

    /// <summary>Initializes a new repo-relative path, rejecting parent directory traversal.</summary>
    public RepoRelativePath(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            throw new ArgumentException("Path must not be null or empty.", nameof(value));
        }

        if (Path.IsPathRooted(value))
        {
            throw new ArgumentException($"RepoRelativePath must not be rooted. Got: '{value}'", nameof(value));
        }

        // Normalize and check for '..' segments
        var normalized = value.Replace('\\', '/');
        foreach (var segment in normalized.Split('/'))
        {
            if (segment == "..")
            {
                throw new ArgumentException($"RepoRelativePath must not contain '..' segments. Got: '{value}'", nameof(value));
            }
        }

        Value = value;
    }

    /// <inheritdoc/>
    public override string ToString() => Value;
}
