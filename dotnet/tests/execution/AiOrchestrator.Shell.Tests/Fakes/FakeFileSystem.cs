// <copyright file="FakeFileSystem.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Shell.Tests.Fakes;

/// <summary>
/// Trivial fake <see cref="IFileSystem"/> for the shell-runner contract tests.
/// Most operations throw; only <see cref="ExistsAsync"/> is exercised by the runner.
/// </summary>
public sealed class FakeFileSystem : IFileSystem
{
    /// <summary>Gets the set of paths considered to exist by <see cref="ExistsAsync"/>.</summary>
    public HashSet<string> ExistingPaths { get; } = new(StringComparer.OrdinalIgnoreCase);

    /// <inheritdoc/>
    public ValueTask<bool> ExistsAsync(AbsolutePath path, CancellationToken ct)
        => ValueTask.FromResult(this.ExistingPaths.Contains(path.Value));

    /// <inheritdoc/>
    public ValueTask<string> ReadAllTextAsync(AbsolutePath path, CancellationToken ct)
        => throw new NotSupportedException();

    /// <inheritdoc/>
    public ValueTask WriteAllTextAsync(AbsolutePath path, string contents, CancellationToken ct)
        => throw new NotSupportedException();

    /// <inheritdoc/>
    public ValueTask<Stream> OpenReadAsync(AbsolutePath path, CancellationToken ct)
        => throw new NotSupportedException();

    /// <inheritdoc/>
    public ValueTask<Stream> OpenWriteExclusiveAsync(AbsolutePath path, FilePermissions perms, CancellationToken ct)
        => throw new NotSupportedException();

    /// <inheritdoc/>
    public ValueTask MoveAtomicAsync(AbsolutePath source, AbsolutePath destination, CancellationToken ct)
        => throw new NotSupportedException();

    /// <inheritdoc/>
    public ValueTask DeleteAsync(AbsolutePath path, CancellationToken ct)
        => throw new NotSupportedException();

    /// <inheritdoc/>
    public ValueTask<MountKind> GetMountKindAsync(AbsolutePath path, CancellationToken ct)
        => throw new NotSupportedException();
}
