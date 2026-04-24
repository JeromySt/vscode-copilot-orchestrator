// <copyright file="GitVerbTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Git.Shell;
using Xunit;

namespace AiOrchestrator.Git.Tests;

/// <summary>Tests for <see cref="GitVerb"/> enum coverage.</summary>
public sealed class GitVerbTests
{
    [Theory]
    [InlineData(GitVerb.Worktree, 0)]
    [InlineData(GitVerb.SparseCheckout, 1)]
    [InlineData(GitVerb.CommitGraph, 2)]
    [InlineData(GitVerb.FsMonitor, 3)]
    [InlineData(GitVerb.MaintenanceRun, 4)]
    public void GitVerb_HasExpectedValues(GitVerb verb, int expected)
    {
        Assert.Equal(expected, (int)verb);
    }

    [Fact]
    public void GitVerb_AllValuesAreDefined()
    {
        Assert.Equal(5, Enum.GetValues<GitVerb>().Length);
    }

    [Fact]
    public void GitVerb_IsDefined_ForAllValues()
    {
        foreach (var verb in Enum.GetValues<GitVerb>())
        {
            Assert.True(Enum.IsDefined(verb));
        }
    }

    [Fact]
    public void GitVerb_IsDefined_FalseForBogusValue()
    {
        Assert.False(Enum.IsDefined((GitVerb)9999));
    }
}
