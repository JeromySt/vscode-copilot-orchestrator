// <copyright file="TempDir.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.IO;

namespace AiOrchestrator.WorktreeLease.Tests;

/// <summary>Creates a scratch worktree directory under the repo's <c>.orchestrator/tmp</c> folder.</summary>
internal sealed class TempDir : IDisposable
{
    public TempDir()
    {
        var repoRoot = FindRepoRoot();
        var baseDir = System.IO.Path.Combine(repoRoot, ".orchestrator", "tmp", "leasetests");
        _ = Directory.CreateDirectory(baseDir);
        this.Path = System.IO.Path.Combine(baseDir, Guid.NewGuid().ToString("N"));
        _ = Directory.CreateDirectory(this.Path);
    }

    public string Path { get; }

    public string Combine(string relative) => System.IO.Path.Combine(this.Path, relative);

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(this.Path))
            {
                Directory.Delete(this.Path, recursive: true);
            }
        }
        catch
        {
            // best effort
        }
    }

    private static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            if (Directory.Exists(System.IO.Path.Combine(dir.FullName, "src", "dotnet")))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        throw new InvalidOperationException("Unable to locate repo root.");
    }
}
