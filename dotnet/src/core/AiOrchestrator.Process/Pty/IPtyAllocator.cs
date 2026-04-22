// <copyright file="IPtyAllocator.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Process.Pty;

/// <summary>
/// Allocates pseudo-terminal (PTY) master/slave pairs for interactive process I/O.
/// On POSIX systems this wraps <c>openpty(3)</c>; on Windows it wraps the ConPTY API.
/// </summary>
public interface IPtyAllocator
{
    /// <summary>Allocates a new PTY pair with the specified dimensions.</summary>
    /// <param name="rows">The number of terminal rows.</param>
    /// <param name="cols">The number of terminal columns.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="PtyPair"/> containing master and slave handles. Dispose to release.</returns>
    ValueTask<PtyPair> AllocateAsync(int rows, int cols, CancellationToken ct);
}
