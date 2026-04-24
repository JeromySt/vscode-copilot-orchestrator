// <copyright file="RunIdTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using AiOrchestrator.Models.Ids;
using Xunit;

namespace AiOrchestrator.Models.Tests;

public sealed class RunIdTests
{
    [Fact]
    public void New_CreatesUniqueIds()
    {
        var a = RunId.New();
        var b = RunId.New();

        Assert.NotEqual(a, b);
    }

    [Fact]
    public void ToString_HasPrefix()
    {
        var id = RunId.New();
        var str = id.ToString();

        Assert.StartsWith("run_", str);
        Assert.Equal(36, str.Length); // "run_" (4) + guid N format (32)
    }

    [Fact]
    public void Parse_RoundTrips()
    {
        var original = RunId.New();
        var parsed = RunId.Parse(original.ToString());

        Assert.Equal(original, parsed);
    }

    [Fact]
    public void TryParse_ValidString_ReturnsTrue()
    {
        var id = RunId.New();

        Assert.True(RunId.TryParse(id.ToString(), out var parsed));
        Assert.Equal(id, parsed);
    }

    [Fact]
    public void TryParse_InvalidPrefix_ReturnsFalse()
    {
        Assert.False(RunId.TryParse("plan_" + Guid.NewGuid().ToString("N"), out _));
    }

    [Fact]
    public void TryParse_Null_ReturnsFalse()
    {
        Assert.False(RunId.TryParse(null!, out _));
    }

    [Fact]
    public void TryParse_InvalidGuid_ReturnsFalse()
    {
        Assert.False(RunId.TryParse("run_zzz", out _));
    }

    [Fact]
    public void Parse_InvalidString_ThrowsFormatException()
    {
        Assert.Throws<FormatException>(() => RunId.Parse("bad"));
    }

    [Fact]
    public void Equality_SameValue_AreEqual()
    {
        var guid = Guid.NewGuid();
        var a = new RunId(guid);
        var b = new RunId(guid);

        Assert.Equal(a, b);
        Assert.Equal(a.GetHashCode(), b.GetHashCode());
    }
}
