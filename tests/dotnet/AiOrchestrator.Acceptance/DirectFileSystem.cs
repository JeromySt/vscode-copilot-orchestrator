// <copyright file="DirectFileSystem.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Acceptance;

/// <summary>
/// Minimal <see cref="IFileSystem"/> implementation used by the acceptance gate. The gate is
/// allowed to read source files directly because it operates on the physical repo layout — every
/// other consumer of <see cref="IFileSystem"/> in the codebase still goes through
/// <c>AiOrchestrator.FileSystem.AsyncFileSystem</c> via the composition root (job 009 INV-8).
/// </summary>
internal sealed class DirectFileSystem : IFileSystem
{
    public ValueTask<bool> ExistsAsync(AbsolutePath path, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        return new ValueTask<bool>(File.Exists(path.Value) || Directory.Exists(path.Value));
    }

    public async ValueTask<string> ReadAllTextAsync(AbsolutePath path, CancellationToken ct)
    {
        return await File.ReadAllTextAsync(path.Value, ct).ConfigureAwait(false);
    }

    public ValueTask WriteAllTextAsync(AbsolutePath path, string contents, CancellationToken ct)
        => throw new NotSupportedException("Acceptance gate is read-only.");

    public ValueTask<Stream> OpenReadAsync(AbsolutePath path, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        Stream s = File.OpenRead(path.Value);
        return new ValueTask<Stream>(s);
    }

    public ValueTask<Stream> OpenWriteExclusiveAsync(AbsolutePath path, FilePermissions perms, CancellationToken ct)
        => throw new NotSupportedException("Acceptance gate is read-only.");

    public ValueTask MoveAtomicAsync(AbsolutePath source, AbsolutePath destination, CancellationToken ct)
        => throw new NotSupportedException("Acceptance gate is read-only.");

    public ValueTask DeleteAsync(AbsolutePath path, CancellationToken ct)
        => throw new NotSupportedException("Acceptance gate is read-only.");

    public ValueTask<MountKind> GetMountKindAsync(AbsolutePath path, CancellationToken ct)
        => new(MountKind.Local);
}
