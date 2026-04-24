// <copyright file="GitignoreManagerTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Git.Gitignore;
using Xunit;

namespace AiOrchestrator.Git.Tests.Gitignore;

public sealed class GitignoreManagerTests : IDisposable
{
    private readonly string tempDir;

    public GitignoreManagerTests()
    {
        this.tempDir = Path.Combine(Path.GetTempPath(), "aio-gitignore-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.tempDir);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(this.tempDir))
            {
                Directory.Delete(this.tempDir, recursive: true);
            }
        }
        catch
        {
            // best-effort cleanup
        }
    }

    [Fact]
    public async Task EnsureEntries_CreatesNewFile_WhenNoneExists()
    {
        var result = await GitignoreManager.EnsureOrchestratorGitIgnoreAsync(this.tempDir);

        Assert.True(result);

        var content = await File.ReadAllTextAsync(Path.Combine(this.tempDir, ".gitignore"));
        Assert.Contains(GitignoreManager.Header, content);
        foreach (var entry in GitignoreManager.OrchestratorEntries)
        {
            Assert.Contains(entry, content);
        }
    }

    [Fact]
    public async Task EnsureEntries_AppendsToExisting_WhenPartiallyPresent()
    {
        var gitignorePath = Path.Combine(this.tempDir, ".gitignore");
        await File.WriteAllTextAsync(gitignorePath, "node_modules/\n.aio/\n");

        var result = await GitignoreManager.EnsureOrchestratorGitIgnoreAsync(this.tempDir);

        Assert.True(result);

        var content = await File.ReadAllTextAsync(gitignorePath);

        // Original content preserved
        Assert.Contains("node_modules/", content);

        // .aio/ should NOT be duplicated — only the missing entries are added
        Assert.Contains(".worktrees/", content);
        Assert.Contains(".orchestrator/", content);
        Assert.Contains(".copilot-cli/", content);
        Assert.Contains(".github/instructions/orchestrator-*.instructions.md", content);
    }

    [Fact]
    public async Task EnsureEntries_NoOp_WhenAllPresent()
    {
        var gitignorePath = Path.Combine(this.tempDir, ".gitignore");
        var allEntries = string.Join('\n', GitignoreManager.OrchestratorEntries) + "\n";
        await File.WriteAllTextAsync(gitignorePath, allEntries);

        var result = await GitignoreManager.EnsureOrchestratorGitIgnoreAsync(this.tempDir);

        Assert.False(result);

        // Content should be unchanged
        var content = await File.ReadAllTextAsync(gitignorePath);
        Assert.Equal(allEntries, content);
    }

    [Fact]
    public async Task IsConfigured_ReturnsFalse_WhenFileDoesNotExist()
    {
        var result = await GitignoreManager.IsConfiguredAsync(this.tempDir);

        Assert.False(result);
    }

    [Fact]
    public async Task IsConfigured_ReturnsTrue_WhenAllEntriesPresent()
    {
        await GitignoreManager.EnsureOrchestratorGitIgnoreAsync(this.tempDir);

        var result = await GitignoreManager.IsConfiguredAsync(this.tempDir);

        Assert.True(result);
    }

    [Fact]
    public void IsDiffOnlyOrchestratorChanges_ReturnsTrueForOrchestratorOnlyDiff()
    {
        var diff = """
            diff --git a/.gitignore b/.gitignore
            index abc123..def456 100644
            --- a/.gitignore
            +++ b/.gitignore
            @@ -1,2 +1,7 @@
             node_modules/
            +
            +# Copilot Orchestrator — managed entries (do not remove)
            +.aio/
            +.worktrees/
            +.orchestrator/
            +.copilot-cli/
            """;

        Assert.True(GitignoreManager.IsDiffOnlyOrchestratorChanges(diff));
    }

    [Fact]
    public void IsDiffOnlyOrchestratorChanges_ReturnsFalseWhenNonOrchestratorChanges()
    {
        var diff = """
            diff --git a/.gitignore b/.gitignore
            --- a/.gitignore
            +++ b/.gitignore
            @@ -1,2 +1,5 @@
             node_modules/
            +.aio/
            +dist/
            +.worktrees/
            """;

        Assert.False(GitignoreManager.IsDiffOnlyOrchestratorChanges(diff));
    }
}

public sealed class GitignoreCommitterTests : IDisposable
{
    private readonly string repoPath;

    public GitignoreCommitterTests()
    {
        this.repoPath = Path.Combine(Path.GetTempPath(), "aio-committer-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.repoPath);

        // Initialize a real git repo
        RunGit(this.repoPath, "init -b main");
        RunGit(this.repoPath, "config user.email test@test.com");
        RunGit(this.repoPath, "config user.name Test");

        var initFile = Path.Combine(this.repoPath, ".gitkeep");
        File.WriteAllText(initFile, "init");
        RunGit(this.repoPath, "add .");
        RunGit(this.repoPath, "commit -m \"Initial commit\"");
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(this.repoPath))
            {
                // Remove read-only attributes set by git
                foreach (var file in Directory.EnumerateFiles(this.repoPath, "*", SearchOption.AllDirectories))
                {
                    try { File.SetAttributes(file, FileAttributes.Normal); }
                    catch { /* ignore */ }
                }

                Directory.Delete(this.repoPath, recursive: true);
            }
        }
        catch
        {
            // best-effort cleanup
        }
    }

    [Fact]
    public async Task EnsureAndCommitAsync_CommitsEntries_OnFirstRun()
    {
        var result = await GitignoreCommitter.EnsureAndCommitAsync(this.repoPath);

        Assert.True(result);

        // Verify the .gitignore is committed (no uncommitted changes)
        var status = RunGit(this.repoPath, "status --porcelain");
        Assert.True(string.IsNullOrWhiteSpace(status), "Expected clean working tree after commit");

        // Verify the commit message
        var lastMessage = RunGit(this.repoPath, "log -1 --format=%s").Trim();
        Assert.Equal(GitignoreCommitter.CommitMessage, lastMessage);

        // Verify .gitignore contains all orchestrator entries
        var content = await File.ReadAllTextAsync(Path.Combine(this.repoPath, ".gitignore"));
        foreach (var entry in GitignoreManager.OrchestratorEntries)
        {
            Assert.Contains(entry, content);
        }
    }

    [Fact]
    public async Task EnsureAndCommitAsync_NoOp_WhenAlreadyCommitted()
    {
        // First call — commits
        var first = await GitignoreCommitter.EnsureAndCommitAsync(this.repoPath);
        Assert.True(first);

        // Second call — no-op
        var second = await GitignoreCommitter.EnsureAndCommitAsync(this.repoPath);
        Assert.False(second);

        // Verify only 2 commits total (initial + gitignore)
        var count = RunGit(this.repoPath, "rev-list --count HEAD").Trim();
        Assert.Equal("2", count);
    }

    [Fact]
    public async Task EnsureAndCommitAsync_CommitIsFirstAfterSeed()
    {
        await GitignoreCommitter.EnsureAndCommitAsync(this.repoPath);

        // Get commit messages in chronological order (oldest first)
        var messages = RunGit(this.repoPath, "log --format=%s --reverse")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(m => m.Trim())
            .ToArray();

        Assert.Equal("Initial commit", messages[0]);
        Assert.Equal(GitignoreCommitter.CommitMessage, messages[1]);
    }

    private static string RunGit(string workDir, string args)
    {
        var psi = new System.Diagnostics.ProcessStartInfo("git", args)
        {
            WorkingDirectory = workDir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        using var proc = System.Diagnostics.Process.Start(psi)
            ?? throw new InvalidOperationException("Failed to start git");
        var stdout = proc.StandardOutput.ReadToEnd();
        proc.WaitForExit();
        return stdout;
    }
}
