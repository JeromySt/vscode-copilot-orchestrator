// <copyright file="GitStatusTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Git;
using Xunit;

namespace AiOrchestrator.Abstractions.Tests;

public sealed class GitStatusTests
{
    [Fact]
    public void Construction_SetsProperties()
    {
        var status = new GitStatus("main", true, 3, 1);

        Assert.Equal("main", status.Branch);
        Assert.True(status.HasUncommittedChanges);
        Assert.Equal(3, status.AheadCount);
        Assert.Equal(1, status.BehindCount);
    }

    [Fact]
    public void Branch_CanBeNull_ForDetachedHead()
    {
        var status = new GitStatus(null, false, 0, 0);

        Assert.Null(status.Branch);
    }

    [Fact]
    public void Record_Equality_Works()
    {
        var a = new GitStatus("main", false, 0, 0);
        var b = new GitStatus("main", false, 0, 0);

        Assert.Equal(a, b);
    }
}
