// <copyright file="PassthroughFileSystem.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.IO;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Audit.Tests;

/// <summary>
/// Minimal pass-through file system used as the IFileSystem dependency for AuditLog.
/// AuditLog itself owns segment writes via System.IO.File (per OE0011 exemption); this
/// stub satisfies DI without imposing a particular VFS shape.
/// </summary>
internal sealed class PassthroughFileSystem : IFileSystem
{
    public ValueTask<bool> ExistsAsync(AbsolutePath path, CancellationToken ct) =>
        ValueTask.FromResult(File.Exists(path.Value) || Directory.Exists(path.Value));

    public ValueTask<string> ReadAllTextAsync(AbsolutePath path, CancellationToken ct) =>
        new(File.ReadAllTextAsync(path.Value, ct));

    public ValueTask WriteAllTextAsync(AbsolutePath path, string contents, CancellationToken ct)
    {
        var dir = Path.GetDirectoryName(path.Value);
        if (!string.IsNullOrEmpty(dir))
        {
            _ = Directory.CreateDirectory(dir);
        }

        return new(File.WriteAllTextAsync(path.Value, contents, ct));
    }

    public ValueTask<Stream> OpenReadAsync(AbsolutePath path, CancellationToken ct) =>
        ValueTask.FromResult<Stream>(new FileStream(path.Value, FileMode.Open, FileAccess.Read, FileShare.Read));

    public ValueTask<Stream> OpenWriteExclusiveAsync(AbsolutePath path, FilePermissions perms, CancellationToken ct)
    {
        var dir = Path.GetDirectoryName(path.Value);
        if (!string.IsNullOrEmpty(dir))
        {
            _ = Directory.CreateDirectory(dir);
        }

        return ValueTask.FromResult<Stream>(new FileStream(path.Value, FileMode.Create, FileAccess.Write, FileShare.None));
    }

    public ValueTask MoveAtomicAsync(AbsolutePath source, AbsolutePath destination, CancellationToken ct)
    {
        File.Move(source.Value, destination.Value, overwrite: true);
        return ValueTask.CompletedTask;
    }

    public ValueTask DeleteAsync(AbsolutePath path, CancellationToken ct)
    {
        if (File.Exists(path.Value))
        {
            File.Delete(path.Value);
        }
        else if (Directory.Exists(path.Value))
        {
            Directory.Delete(path.Value);
        }

        return ValueTask.CompletedTask;
    }

    public ValueTask<MountKind> GetMountKindAsync(AbsolutePath path, CancellationToken ct) =>
        ValueTask.FromResult(MountKind.Local);
}
