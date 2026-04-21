// <copyright file="FileEvent.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.FileSystem.Watching;

/// <summary>Represents a single (debounced) filesystem change event.</summary>
/// <param name="Path">The absolute path that changed.</param>
/// <param name="Kind">The kind of change.</param>
/// <param name="At">The wall-clock instant the change was emitted.</param>
public sealed record FileEvent(AbsolutePath Path, FileChangeKind Kind, DateTimeOffset At);
