// <copyright file="PlanIdTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using AiOrchestrator.Models.Ids;
using Xunit;

namespace AiOrchestrator.Models.Tests;

public sealed class PlanIdTests
{
    [Fact]
    public void New_CreatesUniqueIds()
    {
        var a = PlanId.New();
        var b = PlanId.New();

        Assert.NotEqual(a, b);
    }

    [Fact]
    public void ToString_HasPrefix()
    {
        var id = PlanId.New();
        var str = id.ToString();

        Assert.StartsWith("plan_", str);
        Assert.Equal(37, str.Length); // "plan_" (5) + guid N format (32)
    }

    [Fact]
    public void Parse_RoundTrips()
    {
        var original = PlanId.New();
        var str = original.ToString();
        var parsed = PlanId.Parse(str);

        Assert.Equal(original, parsed);
    }

    [Fact]
    public void TryParse_ValidString_ReturnsTrue()
    {
        var id = PlanId.New();
        var str = id.ToString();

        Assert.True(PlanId.TryParse(str, out var parsed));
        Assert.Equal(id, parsed);
    }

    [Fact]
    public void TryParse_InvalidPrefix_ReturnsFalse()
    {
        Assert.False(PlanId.TryParse("job_" + Guid.NewGuid().ToString("N"), out _));
    }

    [Fact]
    public void TryParse_Null_ReturnsFalse()
    {
        Assert.False(PlanId.TryParse(null!, out _));
    }

    [Fact]
    public void TryParse_EmptyString_ReturnsFalse()
    {
        Assert.False(PlanId.TryParse(string.Empty, out _));
    }

    [Fact]
    public void TryParse_InvalidGuid_ReturnsFalse()
    {
        Assert.False(PlanId.TryParse("plan_not-a-guid", out _));
    }

    [Fact]
    public void Parse_InvalidString_ThrowsFormatException()
    {
        Assert.Throws<FormatException>(() => PlanId.Parse("invalid"));
    }

    [Fact]
    public void Equality_SameValue_AreEqual()
    {
        var guid = Guid.NewGuid();
        var a = new PlanId(guid);
        var b = new PlanId(guid);

        Assert.Equal(a, b);
        Assert.Equal(a.GetHashCode(), b.GetHashCode());
    }
}
