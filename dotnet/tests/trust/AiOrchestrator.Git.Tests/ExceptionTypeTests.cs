// <copyright file="ExceptionTypeTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Git.Exceptions;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;
using Xunit;

namespace AiOrchestrator.Git.Tests;

/// <summary>Tests for Git exception type construction and properties.</summary>
public sealed class ExceptionTypeTests
{
    // ──────────────────────────────────────────────────────────────────────────
    // AuthFailureException
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void AuthFailureException_ConstructsCorrectly()
    {
        var inner = new InvalidOperationException("inner");
        var ex = new AuthFailureException("auth failed", inner)
        {
            RepoUrl = new Uri("https://github.com/example/repo"),
        };

        Assert.Equal("auth failed", ex.Message);
        Assert.Same(inner, ex.InnerException);
        Assert.Equal("github.com", ex.RepoUrl.Host);
    }

    [Fact]
    public void AuthFailureException_WithoutInner()
    {
        var ex = new AuthFailureException("auth failed")
        {
            RepoUrl = new Uri("https://example.com/repo"),
        };

        Assert.Null(ex.InnerException);
        Assert.IsAssignableFrom<GitOperationException>(ex);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // MergeConflictException
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void MergeConflictException_ConstructsCorrectly()
    {
        var paths = ImmutableArray.Create(
            new RepoRelativePath("src/a.cs"),
            new RepoRelativePath("src/b.cs"));

        var ex = new MergeConflictException("merge conflict")
        {
            ConflictingPaths = paths,
        };

        Assert.Equal("merge conflict", ex.Message);
        Assert.Equal(2, ex.ConflictingPaths.Length);
        Assert.Contains(new RepoRelativePath("src/a.cs"), ex.ConflictingPaths);
    }

    [Fact]
    public void MergeConflictException_WithInner()
    {
        var inner = new Exception("inner");
        var ex = new MergeConflictException("conflict", inner)
        {
            ConflictingPaths = ImmutableArray<RepoRelativePath>.Empty,
        };

        Assert.Same(inner, ex.InnerException);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // NetworkErrorException
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void NetworkErrorException_Retryable()
    {
        var ex = new NetworkErrorException("timeout")
        {
            RepoUrl = new Uri("https://github.com/repo"),
            IsRetryable = true,
        };

        Assert.True(ex.IsRetryable);
        Assert.Equal("timeout", ex.Message);
    }

    [Fact]
    public void NetworkErrorException_NonRetryable()
    {
        var ex = new NetworkErrorException("DNS failure")
        {
            RepoUrl = new Uri("https://example.com/repo"),
            IsRetryable = false,
        };

        Assert.False(ex.IsRetryable);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // RefNotFoundException
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void RefNotFoundException_ConstructsCorrectly()
    {
        var ex = new RefNotFoundException("ref not found")
        {
            RefName = "refs/heads/nonexistent",
        };

        Assert.Equal("refs/heads/nonexistent", ex.RefName);
        Assert.IsAssignableFrom<GitOperationException>(ex);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // RefUpdateRaceException
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void RefUpdateRaceException_ConstructsCorrectly()
    {
        var expected = new CommitSha("0000000000000000000000000000000000000000");
        var actual = new CommitSha("1111111111111111111111111111111111111111");

        var ex = new RefUpdateRaceException("CAS failed")
        {
            RefName = "refs/heads/main",
            ExpectedOld = expected,
            ActualOld = actual,
        };

        Assert.Equal("refs/heads/main", ex.RefName);
        Assert.Equal(expected, ex.ExpectedOld);
        Assert.Equal(actual, ex.ActualOld);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // RemoteRejectedException
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void RemoteRejectedException_ConstructsCorrectly()
    {
        var ex = new RemoteRejectedException("push rejected")
        {
            Reason = "non-fast-forward",
            RemoteUrl = "https://github.com/repo",
        };

        Assert.Equal("non-fast-forward", ex.Reason);
        Assert.Equal("https://github.com/repo", ex.RemoteUrl);
        Assert.Equal("push rejected", ex.Message);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // WorktreeLockedException
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void WorktreeLockedException_ConstructsCorrectly()
    {
        var path = new AbsolutePath("/tmp/worktree");
        var ex = new WorktreeLockedException("locked")
        {
            WorktreePath = path,
            LockReason = "another process",
        };

        Assert.Equal(path, ex.WorktreePath);
        Assert.Equal("another process", ex.LockReason);
        Assert.IsAssignableFrom<GitOperationException>(ex);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // All inherit from GitOperationException
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void AllExceptions_InheritFromGitOperationException()
    {
        Assert.IsAssignableFrom<GitOperationException>(
            new AuthFailureException("x") { RepoUrl = new Uri("https://a.com") });
        Assert.IsAssignableFrom<GitOperationException>(
            new MergeConflictException("x") { ConflictingPaths = ImmutableArray<RepoRelativePath>.Empty });
        Assert.IsAssignableFrom<GitOperationException>(
            new NetworkErrorException("x") { RepoUrl = new Uri("https://a.com"), IsRetryable = true });
        Assert.IsAssignableFrom<GitOperationException>(
            new RefNotFoundException("x") { RefName = "r" });
        Assert.IsAssignableFrom<GitOperationException>(
            new RefUpdateRaceException("x") { RefName = "r", ExpectedOld = new CommitSha("0000000000000000000000000000000000000000"), ActualOld = new CommitSha("1111111111111111111111111111111111111111") });
        Assert.IsAssignableFrom<GitOperationException>(
            new RemoteRejectedException("x") { Reason = "r", RemoteUrl = "u" });
        Assert.IsAssignableFrom<GitOperationException>(
            new WorktreeLockedException("x") { WorktreePath = new AbsolutePath("/tmp"), LockReason = "r" });
    }
}
