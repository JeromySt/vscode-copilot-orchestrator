// <copyright file="PassthroughFileSystem.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

#pragma warning disable OE0004 // Test double — wraps real disk I/O for integration testing

using System.Collections.Generic;
using System.IO;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.HookGate.Tests;

internal sealed class PassthroughFileSystem : IFileSystem
{
    public ValueTask<bool> ExistsAsync(AbsolutePath path, CancellationToken ct) => ValueTask.FromResult(File.Exists(path.Value) || Directory.Exists(path.Value));
    public ValueTask<bool> FileExistsAsync(AbsolutePath path, CancellationToken ct) => ValueTask.FromResult(File.Exists(path.Value));
    public ValueTask<bool> DirectoryExistsAsync(AbsolutePath path, CancellationToken ct) => ValueTask.FromResult(Directory.Exists(path.Value));
    public ValueTask CreateDirectoryAsync(AbsolutePath path, CancellationToken ct) { _ = Directory.CreateDirectory(path.Value); return ValueTask.CompletedTask; }
    public ValueTask DeleteDirectoryAsync(AbsolutePath path, bool recursive, CancellationToken ct) { Directory.Delete(path.Value, recursive); return ValueTask.CompletedTask; }
    public ValueTask<string> ReadAllTextAsync(AbsolutePath path, CancellationToken ct) => new(File.ReadAllTextAsync(path.Value, ct));
    public ValueTask WriteAllTextAsync(AbsolutePath path, string contents, CancellationToken ct) => new(File.WriteAllTextAsync(path.Value, contents, ct));
    public ValueTask<byte[]> ReadAllBytesAsync(AbsolutePath path, CancellationToken ct) => new(File.ReadAllBytesAsync(path.Value, ct));
    public ValueTask WriteAllBytesAsync(AbsolutePath path, byte[] contents, CancellationToken ct) => new(File.WriteAllBytesAsync(path.Value, contents, ct));
    public ValueTask<Stream> OpenReadAsync(AbsolutePath path, CancellationToken ct) => ValueTask.FromResult<Stream>(new FileStream(path.Value, FileMode.Open, FileAccess.Read, FileShare.Read));
    public ValueTask<Stream> OpenWriteExclusiveAsync(AbsolutePath path, FilePermissions perms, CancellationToken ct) => ValueTask.FromResult<Stream>(new FileStream(path.Value, FileMode.Create, FileAccess.Write, FileShare.None));
    public ValueTask<Stream> OpenWriteAsync(AbsolutePath path, CancellationToken ct) => ValueTask.FromResult<Stream>(new FileStream(path.Value, FileMode.Create, FileAccess.Write, FileShare.None));
    public ValueTask<Stream> OpenAppendAsync(AbsolutePath path, CancellationToken ct) => ValueTask.FromResult<Stream>(new FileStream(path.Value, FileMode.Append, FileAccess.Write, FileShare.None));
    public ValueTask MoveAtomicAsync(AbsolutePath source, AbsolutePath destination, CancellationToken ct) { File.Move(source.Value, destination.Value, true); return ValueTask.CompletedTask; }
    public ValueTask CopyAsync(AbsolutePath source, AbsolutePath destination, bool overwrite, CancellationToken ct) { File.Copy(source.Value, destination.Value, overwrite); return ValueTask.CompletedTask; }
    public ValueTask DeleteAsync(AbsolutePath path, CancellationToken ct) { if (File.Exists(path.Value)) File.Delete(path.Value); return ValueTask.CompletedTask; }
    public ValueTask<MountKind> GetMountKindAsync(AbsolutePath path, CancellationToken ct) => ValueTask.FromResult(MountKind.Local);
    public async IAsyncEnumerable<AbsolutePath> EnumerateFilesAsync(AbsolutePath directory, string searchPattern, [EnumeratorCancellation] CancellationToken ct)
    {
        if (!Directory.Exists(directory.Value)) yield break;
        foreach (var f in Directory.EnumerateFiles(directory.Value, searchPattern)) { ct.ThrowIfCancellationRequested(); yield return new AbsolutePath(f); }
        await Task.CompletedTask.ConfigureAwait(false);
    }
    public async IAsyncEnumerable<AbsolutePath> EnumerateDirectoriesAsync(AbsolutePath directory, [EnumeratorCancellation] CancellationToken ct)
    {
        if (!Directory.Exists(directory.Value)) yield break;
        foreach (var d in Directory.EnumerateDirectories(directory.Value)) { ct.ThrowIfCancellationRequested(); yield return new AbsolutePath(d); }
        await Task.CompletedTask.ConfigureAwait(false);
    }
}
