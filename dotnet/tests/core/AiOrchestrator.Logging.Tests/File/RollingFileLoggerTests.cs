// <copyright file="RollingFileLoggerTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Logging.File;
using Microsoft.Extensions.Logging;
using Xunit;

namespace AiOrchestrator.Logging.Tests.File;

public sealed class RollingFileLoggerTests : IDisposable
{
    private readonly string tempDir;

    public RollingFileLoggerTests()
    {
        this.tempDir = Path.Combine(Path.GetTempPath(), $"aio-log-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(this.tempDir);
    }

    public void Dispose()
    {
        if (Directory.Exists(this.tempDir))
        {
            Directory.Delete(this.tempDir, recursive: true);
        }
    }

    [Fact]
    public void Writes_LogLines_ToFile()
    {
        var logPath = Path.Combine(this.tempDir, "test.log");
        using var provider = new RollingFileLoggerProvider(new RollingFileLoggerOptions { FilePath = logPath });
        var logger = provider.CreateLogger("TestCategory");

        logger.LogInformation("Hello from test");

        provider.Dispose(); // flush
        var content = System.IO.File.ReadAllText(logPath);
        Assert.Contains("Hello from test", content);
        Assert.Contains("\"c\":\"TestCategory\"", content);
    }

    [Fact]
    public void Rolls_WhenSizeExceeded()
    {
        var logPath = Path.Combine(this.tempDir, "roll.log");
        using var provider = new RollingFileLoggerProvider(new RollingFileLoggerOptions
        {
            FilePath = logPath,
            MaxFileSizeBytes = 500, // small threshold to force rolling
            MaxRetainedFiles = 3,
        });
        var logger = provider.CreateLogger("Roll");

        // Each JSON line is ~150+ bytes; writing 30 lines will exceed 500 bytes multiple times
        for (int i = 0; i < 30; i++)
        {
            logger.LogInformation("Line {Index} with some padding to fill the buffer quickly", i);
        }

        provider.Dispose();
        Assert.True(System.IO.File.Exists($"{logPath}.1"), "Rolled file .1 should exist");
    }

    [Fact]
    public void Retains_MaxFiles()
    {
        var logPath = Path.Combine(this.tempDir, "retain.log");
        using var provider = new RollingFileLoggerProvider(new RollingFileLoggerOptions
        {
            FilePath = logPath,
            MaxFileSizeBytes = 500,
            MaxRetainedFiles = 2,
        });
        var logger = provider.CreateLogger("Retain");

        // Write enough to force several rolls
        for (int i = 0; i < 80; i++)
        {
            logger.LogInformation("Line {Index} padding padding padding padding padding padding", i);
        }

        provider.Dispose();

        // MaxRetainedFiles = 2 means .1 and .2 should exist, but not .3
        Assert.False(System.IO.File.Exists($"{logPath}.3"), "File .3 should have been pruned");
    }

    [Fact]
    public void AioLogPaths_GlobalDaemonLog_IsAbsolute()
    {
        var path = AioLogPaths.GlobalDaemonLog;
        Assert.True(Path.IsPathRooted(path), $"Expected rooted path, got: {path}");
        Assert.EndsWith("aio-daemon.log", path);
    }

    [Fact]
    public void AioLogPaths_RepoLog_ContainsPid()
    {
        var repoRoot = this.tempDir;
        var path = AioLogPaths.RepoLog(repoRoot);
        Assert.Contains($"aio-daemon-{Environment.ProcessId}.log", path);
    }

    [Fact]
    public void AioLogPaths_RepoLog_UnderAioDir()
    {
        var repoRoot = this.tempDir;
        var path = AioLogPaths.RepoLog(repoRoot);
        Assert.StartsWith(Path.Combine(repoRoot, ".aio", "aio_logs"), path);
    }
}
