// <copyright file="DiffResult.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Git.Results;

/// <summary>The kinds of file change a diff entry can represent.</summary>
public enum DiffStatus
{
    /// <summary>The file was added.</summary>
    Added,

    /// <summary>The file was modified.</summary>
    Modified,

    /// <summary>The file was deleted.</summary>
    Deleted,

    /// <summary>The file was renamed.</summary>
    Renamed,
}

/// <summary>One entry in a <see cref="DiffResult"/>.</summary>
/// <param name="Path">The repo-relative path of the affected file.</param>
/// <param name="OldPath">The previous path, when the entry is a rename.</param>
/// <param name="Status">How the file changed.</param>
public sealed record DiffEntry(RepoRelativePath Path, RepoRelativePath? OldPath, DiffStatus Status);

/// <summary>The outcome of a diff.</summary>
/// <param name="Entries">The per-file diff entries.</param>
public sealed record DiffResult(ImmutableArray<DiffEntry> Entries);
