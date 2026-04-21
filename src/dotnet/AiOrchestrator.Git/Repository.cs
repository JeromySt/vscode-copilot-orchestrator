// <copyright file="Repository.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Git;

/// <summary>An opaque, lifetime-bound handle to a git repository on disk.</summary>
public sealed class Repository : IDisposable
{
    private readonly LibGit2Sharp.IRepository underlying;
    private bool disposed;

    /// <summary>Initializes a new instance of the <see cref="Repository"/> class.</summary>
    /// <param name="path">Absolute path to the repo root.</param>
    /// <param name="underlying">The libgit2 repository handle.</param>
    internal Repository(AbsolutePath path, LibGit2Sharp.IRepository underlying)
    {
        this.Path = path;
        this.underlying = underlying;
    }

    /// <summary>Gets the absolute path of this repository.</summary>
    public AbsolutePath Path { get; }

    /// <summary>Gets the underlying libgit2 repository handle. Internal: callers outside this assembly must use <see cref="GitOperations"/>.</summary>
    internal LibGit2Sharp.IRepository Underlying
    {
        get
        {
            ObjectDisposedException.ThrowIf(this.disposed, this);
            return this.underlying;
        }
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        if (this.disposed)
        {
            return;
        }

        this.disposed = true;
        this.underlying.Dispose();
    }
}
