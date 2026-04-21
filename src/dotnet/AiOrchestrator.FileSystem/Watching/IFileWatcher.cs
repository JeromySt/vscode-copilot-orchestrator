// <copyright file="IFileWatcher.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.FileSystem.Watching;

/// <summary>
/// Observes filesystem changes under a configured root, surfacing them as
/// a debounced asynchronous event stream.
/// </summary>
public interface IFileWatcher : IAsyncDisposable
{
    /// <summary>Gets the asynchronous stream of debounced file events.</summary>
    IAsyncEnumerable<FileEvent> Events { get; }
}
