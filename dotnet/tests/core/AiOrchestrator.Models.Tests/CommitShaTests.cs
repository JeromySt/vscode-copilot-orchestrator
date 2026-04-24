// <copyright file="CommitShaTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using AiOrchestrator.Models.Ids;
using Xunit;

namespace AiOrchestrator.Models.Tests;

public sealed class CommitShaTests
{
    private const string ValidSha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

    [Fact]
    public void Construction_ValidHex_Succeeds()
    {
        var sha = new CommitSha(ValidSha);

        Assert.Equal(ValidSha.ToLowerInvariant(), sha.Hex);
    }

    [Fact]
    public void Construction_NormalizesToLowercase()
    {
        var upper = "A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2";
        var sha = new CommitSha(upper);

        Assert.Equal(upper.ToLowerInvariant(), sha.Hex);
    }

    [Fact]
    public void Construction_Null_ThrowsArgumentNull()
    {
        Assert.Throws<ArgumentNullException>(() => new CommitSha(null!));
    }

    [Fact]
    public void Construction_TooShort_ThrowsArgument()
    {
        Assert.Throws<ArgumentException>(() => new CommitSha("abc123"));
    }

    [Fact]
    public void Construction_TooLong_ThrowsArgument()
    {
        Assert.Throws<ArgumentException>(() => new CommitSha(ValidSha + "ff"));
    }

    [Fact]
    public void Construction_NonHex_ThrowsArgument()
    {
        // 40 chars but contains 'g'
        Assert.Throws<ArgumentException>(() => new CommitSha("g1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"));
    }

    [Fact]
    public void ToString_ReturnsHex()
    {
        var sha = new CommitSha(ValidSha);

        Assert.Equal(sha.Hex, sha.ToString());
    }

    [Fact]
    public void Equality_SameHex_AreEqual()
    {
        var a = new CommitSha(ValidSha);
        var b = new CommitSha(ValidSha.ToUpperInvariant());

        Assert.Equal(a, b);
        Assert.Equal(a.GetHashCode(), b.GetHashCode());
    }

    [Fact]
    public void Equality_DifferentHex_AreNotEqual()
    {
        var a = new CommitSha("0000000000000000000000000000000000000000");
        var b = new CommitSha("ffffffffffffffffffffffffffffffffffffffff");

        Assert.NotEqual(a, b);
    }
}
