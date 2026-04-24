// <copyright file="JobIdTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using AiOrchestrator.Models.Ids;
using Xunit;

namespace AiOrchestrator.Models.Tests;

public sealed class JobIdTests
{
    [Fact]
    public void New_CreatesUniqueIds()
    {
        var a = JobId.New();
        var b = JobId.New();

        Assert.NotEqual(a, b);
    }

    [Fact]
    public void ToString_HasPrefix()
    {
        var id = JobId.New();
        var str = id.ToString();

        Assert.StartsWith("job_", str);
        Assert.Equal(36, str.Length); // "job_" (4) + guid N format (32)
    }

    [Fact]
    public void Parse_RoundTrips()
    {
        var original = JobId.New();
        var parsed = JobId.Parse(original.ToString());

        Assert.Equal(original, parsed);
    }

    [Fact]
    public void TryParse_ValidString_ReturnsTrue()
    {
        var id = JobId.New();

        Assert.True(JobId.TryParse(id.ToString(), out var parsed));
        Assert.Equal(id, parsed);
    }

    [Fact]
    public void TryParse_InvalidPrefix_ReturnsFalse()
    {
        Assert.False(JobId.TryParse("plan_" + Guid.NewGuid().ToString("N"), out _));
    }

    [Fact]
    public void TryParse_Null_ReturnsFalse()
    {
        Assert.False(JobId.TryParse(null!, out _));
    }

    [Fact]
    public void TryParse_InvalidGuid_ReturnsFalse()
    {
        Assert.False(JobId.TryParse("job_zzz", out _));
    }

    [Fact]
    public void Parse_InvalidString_ThrowsFormatException()
    {
        Assert.Throws<FormatException>(() => JobId.Parse("bad"));
    }

    [Fact]
    public void Equality_SameValue_AreEqual()
    {
        var guid = Guid.NewGuid();
        var a = new JobId(guid);
        var b = new JobId(guid);

        Assert.Equal(a, b);
        Assert.Equal(a.GetHashCode(), b.GetHashCode());
    }
}
