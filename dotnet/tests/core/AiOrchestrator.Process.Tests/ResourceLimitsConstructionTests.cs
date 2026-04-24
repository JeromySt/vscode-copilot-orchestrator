// <copyright file="ResourceLimitsConstructionTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using Xunit;

namespace AiOrchestrator.Process.Tests;

/// <summary>Unit tests for <see cref="ResourceLimits"/> construction and record semantics.</summary>
public sealed class ResourceLimitsConstructionTests
{
    [Fact]
    public void Default_AllPropertiesAreNull()
    {
        var limits = new ResourceLimits();

        Assert.Null(limits.MaxMemoryBytes);
        Assert.Null(limits.MaxCpuTime);
        Assert.Null(limits.MaxOpenFiles);
        Assert.Null(limits.MaxProcesses);
    }

    [Fact]
    public void Init_SetsMaxMemoryBytes()
    {
        var limits = new ResourceLimits { MaxMemoryBytes = 1024L * 1024 * 512 };

        Assert.Equal(512L * 1024 * 1024, limits.MaxMemoryBytes);
    }

    [Fact]
    public void Init_SetsMaxCpuTime()
    {
        var limits = new ResourceLimits { MaxCpuTime = TimeSpan.FromMinutes(5) };

        Assert.Equal(TimeSpan.FromMinutes(5), limits.MaxCpuTime);
    }

    [Fact]
    public void Init_SetsMaxOpenFiles()
    {
        var limits = new ResourceLimits { MaxOpenFiles = 256 };

        Assert.Equal(256, limits.MaxOpenFiles);
    }

    [Fact]
    public void Init_SetsMaxProcesses()
    {
        var limits = new ResourceLimits { MaxProcesses = 32 };

        Assert.Equal(32, limits.MaxProcesses);
    }

    [Fact]
    public void AllProperties_CanBeSetTogether()
    {
        var limits = new ResourceLimits
        {
            MaxMemoryBytes = 1_073_741_824,
            MaxCpuTime = TimeSpan.FromSeconds(60),
            MaxOpenFiles = 128,
            MaxProcesses = 16,
        };

        Assert.Equal(1_073_741_824L, limits.MaxMemoryBytes);
        Assert.Equal(TimeSpan.FromSeconds(60), limits.MaxCpuTime);
        Assert.Equal(128, limits.MaxOpenFiles);
        Assert.Equal(16, limits.MaxProcesses);
    }

    [Fact]
    public void RecordEquality_EqualLimitsAreEqual()
    {
        var a = new ResourceLimits { MaxMemoryBytes = 100, MaxOpenFiles = 10 };
        var b = new ResourceLimits { MaxMemoryBytes = 100, MaxOpenFiles = 10 };

        Assert.Equal(a, b);
    }

    [Fact]
    public void RecordEquality_DifferentLimitsAreNotEqual()
    {
        var a = new ResourceLimits { MaxMemoryBytes = 100 };
        var b = new ResourceLimits { MaxMemoryBytes = 200 };

        Assert.NotEqual(a, b);
    }

    [Fact]
    public void RecordWith_CreatesModifiedCopy()
    {
        var original = new ResourceLimits { MaxMemoryBytes = 100, MaxOpenFiles = 50 };
        var modified = original with { MaxMemoryBytes = 200 };

        Assert.Equal(200L, modified.MaxMemoryBytes);
        Assert.Equal(50, modified.MaxOpenFiles);
        Assert.Equal(100L, original.MaxMemoryBytes);
    }
}
