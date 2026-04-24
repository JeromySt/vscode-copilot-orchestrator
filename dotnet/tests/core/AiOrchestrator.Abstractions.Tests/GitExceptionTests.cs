// <copyright file="GitExceptionTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Git;
using Xunit;

namespace AiOrchestrator.Abstractions.Tests;

public sealed class GitExceptionTests
{
    [Fact]
    public void Construction_SetsProperties()
    {
        var ex = new GitException("merge", "conflict detected", 1);

        Assert.Equal("merge", ex.Operation);
        Assert.Equal("conflict detected", ex.ErrorMessage);
        Assert.Equal(1, ex.ExitCode);
    }

    [Fact]
    public void ExitCode_Nullable_CanBeNull()
    {
        var ex = new GitException("fetch", "timeout", null);

        Assert.Null(ex.ExitCode);
    }

    [Fact]
    public void Record_Equality_Works()
    {
        var a = new GitException("push", "rejected", 128);
        var b = new GitException("push", "rejected", 128);

        Assert.Equal(a, b);
    }

    [Fact]
    public void Record_Inequality_Works()
    {
        var a = new GitException("push", "rejected", 128);
        var b = new GitException("push", "rejected", 1);

        Assert.NotEqual(a, b);
    }
}
