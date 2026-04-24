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
