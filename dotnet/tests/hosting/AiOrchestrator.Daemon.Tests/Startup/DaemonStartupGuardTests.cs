// <copyright file="DaemonStartupGuardTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipelines;
using System.Linq;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Daemon.Startup;
using AiOrchestrator.Git.Gitignore;
using AiOrchestrator.Models;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace AiOrchestrator.Daemon.Tests.Startup;

public sealed class DaemonStartupGuardTests : IDisposable
{
    private readonly string tempDir;
    private readonly TestProcessSpawner spawner = new();

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
        // Arrange â€” create a real git repo with an initial commit
        RunGit(this.tempDir, "init", "-b", "main");
        RunGit(this.tempDir, "config", "user.email", "test@test.com");
        RunGit(this.tempDir, "config", "user.name", "Test");

        var initFile = Path.Combine(this.tempDir, ".gitkeep");
        File.WriteAllText(initFile, "init");
        RunGit(this.tempDir, "add", ".");
        RunGit(this.tempDir, "commit", "-m", "Initial commit");

        // Act â€” first call should commit .gitignore entries
        await DaemonStartupGuard.EnsureGitignoreAsync(
            this.tempDir, this.spawner, new InMemoryFileSystem(), NullLogger.Instance);

        // Assert â€” .gitignore is committed with all OrchestratorEntries
        var gitignoreContent = RunGit(this.tempDir, "show", "HEAD:.gitignore");
        foreach (var entry in GitignoreManager.OrchestratorEntries)
        {
            Assert.Contains(entry, gitignoreContent);
        }

        // Verify no uncommitted changes remain
        var status = RunGit(this.tempDir, "status", "--porcelain");
        Assert.Empty(status.Trim());

        // Act â€” second call is a no-op (no new commit)
        var commitsBefore = RunGit(this.tempDir, "rev-list", "--count", "HEAD").Trim();
        await DaemonStartupGuard.EnsureGitignoreAsync(
            this.tempDir, this.spawner, new InMemoryFileSystem(), NullLogger.Instance);
        var commitsAfter = RunGit(this.tempDir, "rev-list", "--count", "HEAD").Trim();

        Assert.Equal(commitsBefore, commitsAfter);
    }

    [Fact]
    [ContractTest("DAEMON-GUARD-GITIGNORE-NONGIT")]
    public async Task EnsureGitignoreAsync_DoesNotThrow_OnNonGitDirectory()
    {
        // Arrange â€” plain temp directory, no git repo
        var plainDir = Path.Combine(this.tempDir, "not-a-repo");
        Directory.CreateDirectory(plainDir);

        // Act & Assert â€” should not throw; the exception is caught internally
        var ex = await Record.ExceptionAsync(() =>
            DaemonStartupGuard.EnsureGitignoreAsync(
                plainDir, this.spawner, new InMemoryFileSystem(), NullLogger.Instance));

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

    /// <summary>
    /// Minimal <see cref="IProcessSpawner"/> that starts real processes for integration tests.
    /// </summary>
    private sealed class TestProcessSpawner : IProcessSpawner
    {
        public ValueTask<IProcessHandle> SpawnAsync(ProcessSpec spec, CancellationToken ct)
        {
            var psi = new ProcessStartInfo(spec.Executable)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };

            foreach (var arg in spec.Arguments)
            {
                psi.ArgumentList.Add(arg);
            }

            var process = Process.Start(psi)
                ?? throw new InvalidOperationException($"Failed to start {spec.Executable}");

            return ValueTask.FromResult<IProcessHandle>(new TestProcessHandle(process));
        }

        private sealed class TestProcessHandle : IProcessHandle
        {
            private readonly Process process;
            private readonly Pipe outPipe = new();
            private readonly Pipe errPipe = new();
            private readonly Pipe inPipe = new();
            private readonly Task outPump;
            private readonly Task errPump;

            public TestProcessHandle(Process process)
            {
                this.process = process;
                this.outPump = PumpAsync(process.StandardOutput.BaseStream, this.outPipe.Writer);
                this.errPump = PumpAsync(process.StandardError.BaseStream, this.errPipe.Writer);
            }

            public int ProcessId => this.process.Id;
            public PipeReader StandardOut => this.outPipe.Reader;
            public PipeReader StandardError => this.errPipe.Reader;
            public PipeWriter StandardIn => this.inPipe.Writer;

            public async Task<int> WaitForExitAsync(CancellationToken ct)
            {
                await this.process.WaitForExitAsync(ct).ConfigureAwait(false);
                await Task.WhenAll(this.outPump, this.errPump).ConfigureAwait(false);
                return this.process.ExitCode;
            }

            public ValueTask SignalAsync(ProcessSignal signal, CancellationToken ct)
            {
                try { this.process.Kill(); }
                catch (InvalidOperationException) { }
                return ValueTask.CompletedTask;
            }

            public ValueTask DisposeAsync()
            {
                this.process.Dispose();
                return ValueTask.CompletedTask;
            }

            private static async Task PumpAsync(Stream source, PipeWriter writer)
            {
                try
                {
                    var buffer = new byte[4096];
                    int bytesRead;
                    while ((bytesRead = await source.ReadAsync(buffer).ConfigureAwait(false)) > 0)
                    {
                        await writer.WriteAsync(buffer.AsMemory(0, bytesRead)).ConfigureAwait(false);
                    }
                }
                finally
                {
                    await writer.CompleteAsync().ConfigureAwait(false);
                }
            }
        }
    }
}
