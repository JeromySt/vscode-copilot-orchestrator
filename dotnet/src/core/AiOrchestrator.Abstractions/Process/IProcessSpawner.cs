// <copyright file="IProcessSpawner.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models;

namespace AiOrchestrator.Abstractions.Process;

/// <summary>
/// Spawns child processes described by a <see cref="ProcessSpec"/>.
/// Implementations are responsible for redirecting stdio and applying
/// the process environment and working directory from the spec.
/// </summary>
public interface IProcessSpawner
{
    /// <summary>Spawns a new process according to the provided specification.</summary>
    /// <param name="spec">Describes the executable, arguments, and environment for the new process.</param>
    /// <param name="ct">Cancellation token. Cancellation may terminate the spawned process.</param>
    /// <returns>A handle to the started process.</returns>
    ValueTask<IProcessHandle> SpawnAsync(ProcessSpec spec, CancellationToken ct);
}
