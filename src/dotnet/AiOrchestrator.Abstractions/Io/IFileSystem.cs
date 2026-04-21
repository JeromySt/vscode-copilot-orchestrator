// <copyright file="IFileSystem.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Abstractions.Io;

/// <summary>
/// Provides an abstraction over filesystem operations, enabling testing without real I/O
/// and portability across operating systems and storage backends.
/// </summary>
public interface IFileSystem
{
    /// <summary>Determines whether a file or directory exists at the specified path.</summary>
    /// <param name="path">The path to test.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns><see langword="true"/> if the path exists; otherwise <see langword="false"/>.</returns>
    ValueTask<bool> ExistsAsync(AbsolutePath path, CancellationToken ct);

    /// <summary>Reads all text content from the specified file.</summary>
    /// <param name="path">The path to the file to read.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The full text content of the file.</returns>
    ValueTask<string> ReadAllTextAsync(AbsolutePath path, CancellationToken ct);

    /// <summary>Writes the specified text content to the file at the given path, creating or replacing it.</summary>
    /// <param name="path">The destination path.</param>
    /// <param name="contents">The text content to write.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when the write is finished.</returns>
    ValueTask WriteAllTextAsync(AbsolutePath path, string contents, CancellationToken ct);

    /// <summary>Opens the specified file for sequential reading.</summary>
    /// <param name="path">The path of the file to open.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A readable <see cref="Stream"/> positioned at the start of the file.</returns>
    ValueTask<Stream> OpenReadAsync(AbsolutePath path, CancellationToken ct);

    /// <summary>Opens or creates the specified file for exclusive writing with the given permissions.</summary>
    /// <param name="path">The path of the file to open or create.</param>
    /// <param name="perms">The POSIX permissions to apply to a newly created file.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A writable <see cref="Stream"/> with exclusive access to the file.</returns>
    ValueTask<Stream> OpenWriteExclusiveAsync(AbsolutePath path, FilePermissions perms, CancellationToken ct);

    /// <summary>Atomically moves a file from <paramref name="source"/> to <paramref name="destination"/>.</summary>
    /// <param name="source">The source path.</param>
    /// <param name="destination">The destination path.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when the move is finished.</returns>
    ValueTask MoveAtomicAsync(AbsolutePath source, AbsolutePath destination, CancellationToken ct);

    /// <summary>Deletes the file or empty directory at the specified path.</summary>
    /// <param name="path">The path to delete.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when the deletion is finished.</returns>
    ValueTask DeleteAsync(AbsolutePath path, CancellationToken ct);

    /// <summary>Returns the storage backend kind for the volume that hosts the given path.</summary>
    /// <param name="path">A path on the volume to inspect.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The <see cref="MountKind"/> of the hosting volume.</returns>
    ValueTask<MountKind> GetMountKindAsync(AbsolutePath path, CancellationToken ct);
}
