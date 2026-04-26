// <copyright file="GitignoreDebouncerTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Git.Gitignore;
using Xunit;

namespace AiOrchestrator.Git.Tests.Gitignore;

public sealed class GitignoreDebouncerTests : IDisposable
{
    private readonly string repoRoot;
    private readonly RealProcessSpawner spawner = new();

    public GitignoreDebouncerTests()
    {
        this.repoRoot = Path.Combine(Path.GetTempPath(), "aio-debouncer-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.repoRoot);
        InitGitRepo(this.repoRoot);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(this.repoRoot))
            {
                // Remove read-only attributes (git objects)
                foreach (var f in new DirectoryInfo(this.repoRoot).EnumerateFiles("*", SearchOption.AllDirectories))
                {
                    f.Attributes = FileAttributes.Normal;
                }

                Directory.Delete(this.repoRoot, recursive: true);
            }
        }
        catch
        {
            // best-effort cleanup
        }
    }

    [Fact]
    public async Task RequestEnsure_CommitsAfterDelay()
    {
        await using var debouncer = new GitignoreDebouncer(this.spawner, new PassthroughFileSystem(), delay: TimeSpan.FromMilliseconds(500));

        debouncer.RequestEnsure(this.repoRoot);

        // Immediately: .gitignore should NOT yet be committed
        var logBefore = await RunGitAsync(this.repoRoot, "log --oneline");
        Assert.DoesNotContain(GitignoreCommitter.CommitMessage, logBefore);

        // Wait for the debounce to fire
        await Task.Delay(TimeSpan.FromSeconds(2));

        var logAfter = await RunGitAsync(this.repoRoot, "log --oneline");
        Assert.Contains(GitignoreCommitter.CommitMessage, logAfter);
    }

    [Fact]
    public async Task RequestEnsure_ResetsTimer_OnRapidCalls()
    {
        await using var debouncer = new GitignoreDebouncer(this.spawner, new PassthroughFileSystem(), delay: TimeSpan.FromSeconds(1));

        // T=0: first request
        debouncer.RequestEnsure(this.repoRoot);

        // Tâ‰ˆ500ms: second request â€” should reset the timer
        await Task.Delay(TimeSpan.FromMilliseconds(500));
        debouncer.RequestEnsure(this.repoRoot);

        // Tâ‰ˆ1.2s: NOT yet committed (timer was reset at T=500ms, fires at Tâ‰ˆ1.5s)
        await Task.Delay(TimeSpan.FromMilliseconds(700));
        var logEarly = await RunGitAsync(this.repoRoot, "log --oneline");
        Assert.DoesNotContain(GitignoreCommitter.CommitMessage, logEarly);

        // Tâ‰ˆ2.5s: IS committed
        await Task.Delay(TimeSpan.FromMilliseconds(1300));
        var logLate = await RunGitAsync(this.repoRoot, "log --oneline");
        Assert.Contains(GitignoreCommitter.CommitMessage, logLate);
    }

    [Fact]
    public async Task OnBranchSwitch_StashesUncommittedChanges()
    {
        // Commit an initial .gitignore so we can modify it
        await File.WriteAllTextAsync(Path.Combine(this.repoRoot, ".gitignore"), "node_modules/\n");
        await RunGitAsync(this.repoRoot, "add .gitignore");
        await RunGitAsync(this.repoRoot, "commit -m \"initial gitignore\" --no-verify");

        // Modify .gitignore (uncommitted change)
        await File.AppendAllTextAsync(Path.Combine(this.repoRoot, ".gitignore"), "extra-line\n");

        // Verify dirty state
        var statusBefore = await RunGitAsync(this.repoRoot, "status --porcelain -- .gitignore");
        Assert.NotEmpty(statusBefore);

        // OnBranchSwitch should stash the change
        await using var debouncer = new GitignoreDebouncer(this.spawner, new PassthroughFileSystem(), delay: TimeSpan.FromMilliseconds(500));
        await debouncer.OnBranchSwitchAsync(this.repoRoot);

        // Working tree should be clean after stash
        var statusAfter = await RunGitAsync(this.repoRoot, "status --porcelain -- .gitignore");
        Assert.Empty(statusAfter);

        // After debounce delay: entries re-committed
        await Task.Delay(TimeSpan.FromSeconds(2));
        var log = await RunGitAsync(this.repoRoot, "log --oneline");
        Assert.Contains(GitignoreCommitter.CommitMessage, log);
    }

    [Fact]
    public async Task EnsureNow_BypassesDebounce()
    {
        await using var debouncer = new GitignoreDebouncer(this.spawner, new PassthroughFileSystem(), delay: TimeSpan.FromSeconds(60));

        var committed = await debouncer.EnsureNowAsync(this.repoRoot);

        Assert.True(committed);
        var log = await RunGitAsync(this.repoRoot, "log --oneline");
        Assert.Contains(GitignoreCommitter.CommitMessage, log);
    }

    [Fact]
    public async Task Dispose_CancelsPending()
    {
        var debouncer = new GitignoreDebouncer(this.spawner, new PassthroughFileSystem(), delay: TimeSpan.FromSeconds(5));
        debouncer.RequestEnsure(this.repoRoot);

        // Dispose immediately â€” should cancel the pending write
        await debouncer.DisposeAsync();

        // Wait past what the delay would have been
        await Task.Delay(TimeSpan.FromSeconds(1));

        // Nothing should have been committed
        var log = await RunGitAsync(this.repoRoot, "log --oneline");
        Assert.DoesNotContain(GitignoreCommitter.CommitMessage, log);
    }

    private static void InitGitRepo(string path)
    {
        RunGitSync(path, "init");
        RunGitSync(path, "config user.email \"test@test.com\"");
        RunGitSync(path, "config user.name \"Test\"");

        // Create an initial commit so `git log` works
        File.WriteAllText(Path.Combine(path, "README.md"), "# Test\n");
        RunGitSync(path, "add README.md");
        RunGitSync(path, "commit -m \"initial commit\" --no-verify");
    }

    private static void RunGitSync(string workDir, string args)
    {
        var psi = new System.Diagnostics.ProcessStartInfo("git", args)
        {
            WorkingDirectory = workDir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        using var proc = System.Diagnostics.Process.Start(psi)!;
        proc.WaitForExit();
        if (proc.ExitCode != 0)
        {
            var stderr = proc.StandardError.ReadToEnd();
            throw new InvalidOperationException($"git {args} failed: {stderr}");
        }
    }

    private static async Task<string> RunGitAsync(string workDir, string args)
    {
        var psi = new System.Diagnostics.ProcessStartInfo("git", args)
        {
            WorkingDirectory = workDir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        using var proc = System.Diagnostics.Process.Start(psi)!;
        var output = await proc.StandardOutput.ReadToEndAsync();
        await proc.WaitForExitAsync();
        return output.Trim();
    }
}
