// <copyright file="NullFileSystem.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Process.Tests;

/// <summary>
/// No-op <see cref="IFileSystem"/> for tests that spawn real processes
/// but do not exercise filesystem paths (cgroup writes, crash dump collection).
/// </summary>
internal sealed class NullFileSystem : IFileSystem
{
    public static readonly NullFileSystem Instance = new();

    public ValueTask<bool> ExistsAsync(AbsolutePath path, CancellationToken ct) => ValueTask.FromResult(false);

    public ValueTask<bool> FileExistsAsync(AbsolutePath path, CancellationToken ct) => ValueTask.FromResult(false);

    public ValueTask<bool> DirectoryExistsAsync(AbsolutePath path, CancellationToken ct) => ValueTask.FromResult(false);

    public ValueTask CreateDirectoryAsync(AbsolutePath path, CancellationToken ct) => ValueTask.CompletedTask;

    public ValueTask DeleteDirectoryAsync(AbsolutePath path, bool recursive, CancellationToken ct) => ValueTask.CompletedTask;

    public ValueTask<string> ReadAllTextAsync(AbsolutePath path, CancellationToken ct) => ValueTask.FromResult(string.Empty);

    public ValueTask WriteAllTextAsync(AbsolutePath path, string contents, CancellationToken ct) => ValueTask.CompletedTask;

    public ValueTask<byte[]> ReadAllBytesAsync(AbsolutePath path, CancellationToken ct) => ValueTask.FromResult(Array.Empty<byte>());

    public ValueTask WriteAllBytesAsync(AbsolutePath path, byte[] contents, CancellationToken ct) => ValueTask.CompletedTask;

    public ValueTask<Stream> OpenReadAsync(AbsolutePath path, CancellationToken ct) => ValueTask.FromResult<Stream>(Stream.Null);

    public ValueTask<Stream> OpenWriteAsync(AbsolutePath path, CancellationToken ct) => ValueTask.FromResult<Stream>(Stream.Null);

    public ValueTask<Stream> OpenAppendAsync(AbsolutePath path, CancellationToken ct) => ValueTask.FromResult<Stream>(Stream.Null);

    public ValueTask<Stream> OpenWriteExclusiveAsync(AbsolutePath path, FilePermissions perms, CancellationToken ct) => ValueTask.FromResult<Stream>(Stream.Null);

    public ValueTask MoveAtomicAsync(AbsolutePath source, AbsolutePath destination, CancellationToken ct) => ValueTask.CompletedTask;

    public ValueTask DeleteAsync(AbsolutePath path, CancellationToken ct) => ValueTask.CompletedTask;

    public ValueTask CopyAsync(AbsolutePath source, AbsolutePath destination, bool overwrite, CancellationToken ct) => ValueTask.CompletedTask;

    public async IAsyncEnumerable<AbsolutePath> EnumerateFilesAsync(AbsolutePath directory, string searchPattern, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        await Task.CompletedTask.ConfigureAwait(false);
        yield break;
    }

    public async IAsyncEnumerable<AbsolutePath> EnumerateDirectoriesAsync(AbsolutePath directory, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        await Task.CompletedTask.ConfigureAwait(false);
        yield break;
    }

    public ValueTask<MountKind> GetMountKindAsync(AbsolutePath path, CancellationToken ct) => ValueTask.FromResult(MountKind.Local);
}
