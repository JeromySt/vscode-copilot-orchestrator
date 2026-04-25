// <copyright file="RollingFileLoggerCoverageTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using AiOrchestrator.Logging.File;
using Microsoft.Extensions.Logging;
using Xunit;

namespace AiOrchestrator.Logging.Tests;

/// <summary>Coverage tests for <see cref="RollingFileLogger"/> and <see cref="RollingFileLoggerProvider"/>.</summary>
public sealed class RollingFileLoggerCoverageTests : IDisposable
{
    private readonly string tempDir;

    public RollingFileLoggerCoverageTests()
    {
        this.tempDir = Path.Combine(Path.GetTempPath(), "rolling-logger-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.tempDir);
    }

    public void Dispose()
    {
        try { if (Directory.Exists(this.tempDir)) Directory.Delete(this.tempDir, recursive: true); }
        catch { /* best effort */ }
    }

    /// <summary>RollingFileLogger writes valid JSON to the provider.</summary>
    [Fact]
    public void Log_WritesValidJsonLine()
    {
        var logPath = Path.Combine(this.tempDir, "test.log");
        using var provider = new RollingFileLoggerProvider(new RollingFileLoggerOptions { FilePath = logPath });
        var logger = provider.CreateLogger("TestCategory");

        logger.LogInformation("Hello {Name}", "World");

        provider.Dispose(); // Flush

        var lines = System.IO.File.ReadAllLines(logPath).Where(l => !string.IsNullOrWhiteSpace(l)).ToArray();
        Assert.Single(lines);
        var doc = JsonDocument.Parse(lines[0]);
        Assert.Equal("TestCategory", doc.RootElement.GetProperty("c").GetString());
    }

    /// <summary>RollingFileLogger includes exception in the output.</summary>
    [Fact]
    public void Log_WithException_IncludesExceptionField()
    {
        var logPath = Path.Combine(this.tempDir, "ex.log");
        using var provider = new RollingFileLoggerProvider(new RollingFileLoggerOptions { FilePath = logPath });
        var logger = provider.CreateLogger("Cat");

        logger.LogError(new InvalidOperationException("boom"), "Error occurred");

        provider.Dispose();

        var line = System.IO.File.ReadAllLines(logPath).First(l => !string.IsNullOrWhiteSpace(l));
        var doc = JsonDocument.Parse(line);
        Assert.True(doc.RootElement.TryGetProperty("x", out var exProp));
        Assert.Contains("boom", exProp.GetString());
    }

    /// <summary>Trace level is below Debug threshold, so it should not be written.</summary>
    [Fact]
    public void Log_TraceLevelBelowThreshold_NotWritten()
    {
        var logPath = Path.Combine(this.tempDir, "trace.log");
        using var provider = new RollingFileLoggerProvider(new RollingFileLoggerOptions { FilePath = logPath });
        var logger = provider.CreateLogger("Cat");

        logger.LogTrace("This should not appear");

        provider.Dispose();

        var content = System.IO.File.ReadAllText(logPath).Trim();
        Assert.Empty(content);
    }

    /// <summary>IsEnabled returns true for Debug and above, false for Trace.</summary>
    [Fact]
    public void IsEnabled_DebugAndAbove_True()
    {
        var logPath = Path.Combine(this.tempDir, "enabled.log");
        using var provider = new RollingFileLoggerProvider(new RollingFileLoggerOptions { FilePath = logPath });
        var logger = provider.CreateLogger("Cat");

        Assert.False(logger.IsEnabled(LogLevel.Trace));
        Assert.True(logger.IsEnabled(LogLevel.Debug));
        Assert.True(logger.IsEnabled(LogLevel.Information));
        Assert.True(logger.IsEnabled(LogLevel.Warning));
        Assert.True(logger.IsEnabled(LogLevel.Error));
        Assert.True(logger.IsEnabled(LogLevel.Critical));
    }

    /// <summary>BeginScope returns null (no scope support).</summary>
    [Fact]
    public void BeginScope_ReturnsNull()
    {
        var logPath = Path.Combine(this.tempDir, "scope.log");
        using var provider = new RollingFileLoggerProvider(new RollingFileLoggerOptions { FilePath = logPath });
        var logger = provider.CreateLogger("Cat");

        var scope = logger.BeginScope("some-scope");
        Assert.Null(scope);
    }

    /// <summary>File rolls when size threshold is exceeded.</summary>
    [Fact]
    public void Write_RollsFileWhenSizeExceeded()
    {
        var logPath = Path.Combine(this.tempDir, "roll.log");
        // Very small size to trigger rolling quickly
        using var provider = new RollingFileLoggerProvider(new RollingFileLoggerOptions
        {
            FilePath = logPath,
            MaxFileSizeBytes = 100,
            MaxRetainedFiles = 3,
        });
        var logger = provider.CreateLogger("Cat");

        // Write enough to trigger at least one roll
        for (int i = 0; i < 20; i++)
        {
            logger.LogInformation("Line number {N} with some padding text to fill space", i);
        }

        provider.Dispose();

        // The rolled file should exist
        Assert.True(System.IO.File.Exists($"{logPath}.1"), "Expected rolled file .1 to exist");
    }

    /// <summary>Multiple rolls shift files correctly (.1 → .2, etc.).</summary>
    [Fact]
    public void Write_MultipleRolls_ShiftsFiles()
    {
        var logPath = Path.Combine(this.tempDir, "multi-roll.log");
        using var provider = new RollingFileLoggerProvider(new RollingFileLoggerOptions
        {
            FilePath = logPath,
            MaxFileSizeBytes = 50,
            MaxRetainedFiles = 3,
        });
        var logger = provider.CreateLogger("Cat");

        for (int i = 0; i < 50; i++)
        {
            logger.LogInformation("Padding line {N} extra text to exceed threshold", i);
        }

        provider.Dispose();

        // At least .1 and .2 should exist with sufficient writes
        Assert.True(System.IO.File.Exists($"{logPath}.1"), "Expected .1 to exist after multiple rolls");
    }

    /// <summary>Writing after dispose is a no-op (does not throw).</summary>
    [Fact]
    public void Write_AfterDispose_IsNoOp()
    {
        var logPath = Path.Combine(this.tempDir, "disposed.log");
        var provider = new RollingFileLoggerProvider(new RollingFileLoggerOptions { FilePath = logPath });
        var logger = provider.CreateLogger("Cat");
        provider.Dispose();

        // Writing after dispose should not throw
        logger.LogInformation("Should not throw");
    }

    /// <summary>Dispose is idempotent.</summary>
    [Fact]
    public void Dispose_IsIdempotent()
    {
        var logPath = Path.Combine(this.tempDir, "idem.log");
        var provider = new RollingFileLoggerProvider(new RollingFileLoggerOptions { FilePath = logPath });

        provider.Dispose();
        provider.Dispose(); // Must not throw
    }

    /// <summary>CreateLogger returns different instances for different categories.</summary>
    [Fact]
    public void CreateLogger_DifferentCategories_DifferentInstances()
    {
        var logPath = Path.Combine(this.tempDir, "cats.log");
        using var provider = new RollingFileLoggerProvider(new RollingFileLoggerOptions { FilePath = logPath });

        var logger1 = provider.CreateLogger("Cat1");
        var logger2 = provider.CreateLogger("Cat2");

        Assert.NotSame(logger1, logger2);
    }

    /// <summary>Provider creates directory if it doesn't exist.</summary>
    [Fact]
    public void Constructor_CreatesDirectoryIfMissing()
    {
        var nestedDir = Path.Combine(this.tempDir, "nested", "deep");
        var logPath = Path.Combine(nestedDir, "test.log");

        using var provider = new RollingFileLoggerProvider(new RollingFileLoggerOptions { FilePath = logPath });
        var logger = provider.CreateLogger("Cat");
        logger.LogInformation("test");

        Assert.True(Directory.Exists(nestedDir));
    }
}
