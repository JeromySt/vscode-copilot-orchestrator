// <copyright file="FileChangeKind.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.FileSystem.Watching;

/// <summary>The kind of change observed on a watched filesystem entry.</summary>
public enum FileChangeKind
{
    /// <summary>The entry was newly created.</summary>
    Created,

    /// <summary>The entry's contents or metadata changed.</summary>
    Modified,

    /// <summary>The entry was removed.</summary>
    Deleted,

    /// <summary>The entry was renamed.</summary>
    Renamed,
}
