// <copyright file="TestRepo.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Paths;
using LibGit2Sharp;

namespace AiOrchestrator.Git.Tests;

/// <summary>Creates a real on-disk git repository in a scratch temp dir for end-to-end tests.</summary>
internal sealed class TestRepo : IDisposable
{
    private readonly string root;

    public TestRepo()
    {
        this.root = Path.Combine(Path.GetTempPath(), "aio-git-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.root);
        LibGit2Sharp.Repository.Init(this.root);

        // Configure default identity so commits work.
        using var repo = new LibGit2Sharp.Repository(this.root);
        repo.Config.Set("user.name", "tester", ConfigurationLevel.Local);
        repo.Config.Set("user.email", "tester@example.com", ConfigurationLevel.Local);
    }

    public AbsolutePath Root => new(this.root);

    /// <summary>Writes a file inside the repo and stages+commits it; returns the new HEAD SHA.</summary>
    public string WriteAndCommit(string relativePath, string content, string message = "test commit")
    {
        var full = Path.Combine(this.root, relativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        File.WriteAllText(full, content);
        using var repo = new LibGit2Sharp.Repository(this.root);
        Commands.Stage(repo, relativePath);
        var sig = new Signature("tester", "tester@example.com", DateTimeOffset.UtcNow);
        var c = repo.Commit(message, sig, sig, new CommitOptions { AllowEmptyCommit = true });
        return c.Sha;
    }

    public void Dispose()
    {
        try
        {
            DeleteDirectory(this.root);
        }
        catch
        {
            // best-effort cleanup
        }
    }

    private static void DeleteDirectory(string path)
    {
        if (!Directory.Exists(path))
        {
            return;
        }

        foreach (var f in Directory.EnumerateFiles(path, "*", SearchOption.AllDirectories))
        {
            File.SetAttributes(f, FileAttributes.Normal);
        }

        Directory.Delete(path, recursive: true);
    }
}
