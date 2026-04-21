// <copyright file="IMountInspector.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.FileSystem.Mount;

/// <summary>
/// Inspects the storage backend that hosts a given filesystem path.
/// Implementations are platform-specific (Linux parses <c>/proc/self/mountinfo</c>;
/// Windows queries Win32 volume APIs).
/// </summary>
public interface IMountInspector
{
    /// <summary>Returns the <see cref="MountKind"/> of the volume hosting <paramref name="path"/>.</summary>
    /// <param name="path">A path on the volume to inspect.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The detected <see cref="MountKind"/>.</returns>
    ValueTask<MountKind> InspectAsync(AbsolutePath path, CancellationToken ct);
}
