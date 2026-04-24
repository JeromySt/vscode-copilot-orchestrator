// <copyright file="GitOptionsCoverageTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Paths;
using Xunit;

namespace AiOrchestrator.Git.Tests;

/// <summary>Tests for <see cref="GitOptions"/> defaults and custom values.</summary>
public sealed class GitOptionsCoverageTests
{
    [Fact]
    public void Defaults()
    {
        var opts = new GitOptions();

        Assert.Equal(TimeSpan.FromMilliseconds(100), opts.ProgressTickInterval);
        Assert.Null(opts.GitExecutable);
        Assert.True(opts.PreferShellForWorktree);
    }

    [Fact]
    public void CustomValues()
    {
        var opts = new GitOptions
        {
            ProgressTickInterval = TimeSpan.FromMilliseconds(50),
            GitExecutable = new AbsolutePath("/usr/local/bin/git"),
            PreferShellForWorktree = false,
        };

        Assert.Equal(TimeSpan.FromMilliseconds(50), opts.ProgressTickInterval);
        Assert.Equal("/usr/local/bin/git", opts.GitExecutable?.Value);
        Assert.False(opts.PreferShellForWorktree);
    }

    [Fact]
    public void RecordWith_CreatesModifiedCopy()
    {
        var original = new GitOptions();
        var modified = original with { PreferShellForWorktree = false };

        Assert.True(original.PreferShellForWorktree);
        Assert.False(modified.PreferShellForWorktree);
    }
}
