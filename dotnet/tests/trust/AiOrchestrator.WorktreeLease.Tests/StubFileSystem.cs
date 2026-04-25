// <copyright file="StubFileSystem.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.WorktreeLease.Tests;

/// <summary>
/// Minimal <see cref="IFileSystem"/> stub used by lease tests. The production
/// WorktreeLease code does not invoke any methods on <see cref="IFileSystem"/> —
/// it uses <see cref="System.IO.FileStream"/> directly for CAS. The stub therefore
/// throws on every call so tests fail loudly if that ever changes.
/// </summary>
internal sealed class StubFileSystem : IFileSystem
{
    public ValueTask<bool> ExistsAsync(AbsolutePath path, CancellationToken ct) => throw new NotSupportedException();

    public ValueTask<string> ReadAllTextAsync(AbsolutePath path, CancellationToken ct) => throw new NotSupportedException();

    public ValueTask WriteAllTextAsync(AbsolutePath path, string contents, CancellationToken ct) => throw new NotSupportedException();

    public ValueTask<System.IO.Stream> OpenReadAsync(AbsolutePath path, CancellationToken ct) => throw new NotSupportedException();

    public ValueTask<System.IO.Stream> OpenWriteExclusiveAsync(AbsolutePath path, FilePermissions perms, CancellationToken ct) => throw new NotSupportedException();

    public ValueTask MoveAtomicAsync(AbsolutePath source, AbsolutePath destination, CancellationToken ct) => throw new NotSupportedException();

    public ValueTask DeleteAsync(AbsolutePath path, CancellationToken ct) => throw new NotSupportedException();

    public ValueTask<MountKind> GetMountKindAsync(AbsolutePath path, CancellationToken ct) => throw new NotSupportedException();

    public ValueTask<bool> FileExistsAsync(AbsolutePath path, CancellationToken ct) => throw new NotSupportedException();

    public ValueTask<bool> DirectoryExistsAsync(AbsolutePath path, CancellationToken ct) => throw new NotSupportedException();

    public ValueTask CreateDirectoryAsync(AbsolutePath path, CancellationToken ct) => throw new NotSupportedException();

    public ValueTask DeleteDirectoryAsync(AbsolutePath path, bool recursive, CancellationToken ct) => throw new NotSupportedException();

    public ValueTask<byte[]> ReadAllBytesAsync(AbsolutePath path, CancellationToken ct) => throw new NotSupportedException();

    public ValueTask WriteAllBytesAsync(AbsolutePath path, byte[] contents, CancellationToken ct) => throw new NotSupportedException();

    public ValueTask CopyAsync(AbsolutePath source, AbsolutePath destination, bool overwrite, CancellationToken ct) => throw new NotSupportedException();

    public IAsyncEnumerable<AbsolutePath> EnumerateFilesAsync(AbsolutePath directory, string searchPattern, CancellationToken ct) => throw new NotSupportedException();

    public IAsyncEnumerable<AbsolutePath> EnumerateDirectoriesAsync(AbsolutePath directory, CancellationToken ct) => throw new NotSupportedException();

    public ValueTask<Stream> OpenWriteAsync(AbsolutePath path, CancellationToken ct) => throw new NotSupportedException();

    public ValueTask<Stream> OpenAppendAsync(AbsolutePath path, CancellationToken ct) => throw new NotSupportedException();
}
