// <copyright file="DaemonStartupGuardTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using AiOrchestrator.Daemon.Startup;
using AiOrchestrator.Git.Gitignore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace AiOrchestrator.Daemon.Tests.Startup;

public sealed class DaemonStartupGuardTests : IDisposable
{
    private readonly string tempDir;

    public DaemonStartupGuardTests()
    {
        this.tempDir = Path.Combine(Path.GetTempPath(), "daemon-guard-test", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.tempDir);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(this.tempDir))
            {
                ForceDeleteDirectory(this.tempDir);
            }
        }
        catch
        {
            // best-effort cleanup
        }
    }

    [Fact]
    [ContractTest("DAEMON-GUARD-GITIGNORE-COMMIT")]
    public async Task EnsureGitignoreAsync_CommitsEntries_WhenNotPresent()
    {
        // Arrange — create a real git repo with an initial commit
        RunGit(this.tempDir, "init", "-b", "main");
        RunGit(this.tempDir, "config", "user.email", "test@test.com");
        RunGit(this.tempDir, "config", "user.name", "Test");

        var initFile = Path.Combine(this.tempDir, ".gitkeep");
        File.WriteAllText(initFile, "init");
        RunGit(this.tempDir, "add", ".");
        RunGit(this.tempDir, "commit", "-m", "Initial commit");

        // Act — first call should commit .gitignore entries
        await DaemonStartupGuard.EnsureGitignoreAsync(
            this.tempDir, NullLogger.Instance);

        // Assert — .gitignore is committed with all OrchestratorEntries
        var gitignoreContent = RunGit(this.tempDir, "show", "HEAD:.gitignore");
        foreach (var entry in GitignoreManager.OrchestratorEntries)
        {
            Assert.Contains(entry, gitignoreContent);
        }

        // Verify no uncommitted changes remain
        var status = RunGit(this.tempDir, "status", "--porcelain");
        Assert.Empty(status.Trim());

        // Act — second call is a no-op (no new commit)
        var commitsBefore = RunGit(this.tempDir, "rev-list", "--count", "HEAD").Trim();
        await DaemonStartupGuard.EnsureGitignoreAsync(
            this.tempDir, NullLogger.Instance);
        var commitsAfter = RunGit(this.tempDir, "rev-list", "--count", "HEAD").Trim();

        Assert.Equal(commitsBefore, commitsAfter);
    }

    [Fact]
    [ContractTest("DAEMON-GUARD-GITIGNORE-NONGIT")]
    public async Task EnsureGitignoreAsync_DoesNotThrow_OnNonGitDirectory()
    {
        // Arrange — plain temp directory, no git repo
        var plainDir = Path.Combine(this.tempDir, "not-a-repo");
        Directory.CreateDirectory(plainDir);

        // Act & Assert — should not throw; the exception is caught internally
        var ex = await Record.ExceptionAsync(() =>
            DaemonStartupGuard.EnsureGitignoreAsync(
                plainDir, NullLogger.Instance));

        Assert.Null(ex);
    }

    private static string RunGit(string workDir, params string[] args)
    {
        var psi = new ProcessStartInfo("git")
        {
            WorkingDirectory = workDir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var arg in args)
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("Failed to start git process");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();

        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"git {string.Join(' ', args)} failed (exit {process.ExitCode}) in {workDir}: {stderr}");
        }

        return stdout;
    }

    private static void ForceDeleteDirectory(string path)
    {
        foreach (var file in Directory.EnumerateFiles(path, "*", SearchOption.AllDirectories))
        {
            try
            {
                File.SetAttributes(file, FileAttributes.Normal);
            }
            catch
            {
                // best-effort
            }
        }

        Directory.Delete(path, recursive: true);
    }
}
