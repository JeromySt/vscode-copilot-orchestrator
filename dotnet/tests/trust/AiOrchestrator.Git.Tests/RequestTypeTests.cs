// <copyright file="RequestTypeTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Git.Requests;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;
using Xunit;

namespace AiOrchestrator.Git.Tests;

/// <summary>Tests for Git request type construction and defaults.</summary>
public sealed class RequestTypeTests
{
    private static readonly AuthContext TestPrincipal = Mocks.TestPrincipal;

    // ──────────────────────────────────────────────────────────────────────────
    // CloneRequest
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void CloneRequest_Defaults()
    {
        var req = new CloneRequest
        {
            SourceUrl = new Uri("https://github.com/owner/repo"),
            Destination = new AbsolutePath("/tmp/clone"),
            Principal = TestPrincipal,
        };

        Assert.False(req.IsBare);
        Assert.Null(req.Filter);
        Assert.Null(req.Branch);
    }

    [Fact]
    public void CloneRequest_AllProperties()
    {
        var req = new CloneRequest
        {
            SourceUrl = new Uri("https://github.com/owner/repo"),
            Destination = new AbsolutePath("/tmp/clone"),
            Principal = TestPrincipal,
            IsBare = true,
            Filter = "blob:none",
            Branch = "develop",
        };

        Assert.True(req.IsBare);
        Assert.Equal("blob:none", req.Filter);
        Assert.Equal("develop", req.Branch);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // CommitRequest
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void CommitRequest_Defaults()
    {
        var req = new CommitRequest
        {
            Message = "feat: add thing",
            Author = TestPrincipal,
        };

        Assert.Null(req.Committer);
        Assert.False(req.AllowEmpty);
    }

    [Fact]
    public void CommitRequest_AllProperties()
    {
        var req = new CommitRequest
        {
            Message = "fix: bug",
            Author = TestPrincipal,
            Committer = TestPrincipal,
            AllowEmpty = true,
        };

        Assert.NotNull(req.Committer);
        Assert.True(req.AllowEmpty);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // FetchRequest
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void FetchRequest_Defaults()
    {
        var req = new FetchRequest
        {
            Principal = TestPrincipal,
        };

        Assert.Equal("origin", req.Remote);
        Assert.Empty(req.RefSpecs);
        Assert.False(req.Prune);
    }

    [Fact]
    public void FetchRequest_CustomRemote()
    {
        var req = new FetchRequest
        {
            Principal = TestPrincipal,
            Remote = "upstream",
            RefSpecs = ImmutableArray.Create("+refs/heads/*:refs/remotes/upstream/*"),
            Prune = true,
        };

        Assert.Equal("upstream", req.Remote);
        Assert.Single(req.RefSpecs);
        Assert.True(req.Prune);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // MergeRequest
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void MergeRequest_Defaults()
    {
        var sha = new CommitSha("abcdef0123456789abcdef0123456789abcdef01");
        var req = new MergeRequest
        {
            Source = sha,
            Principal = TestPrincipal,
        };

        Assert.Null(req.Message);
        Assert.False(req.NoFastForward);
    }

    [Fact]
    public void MergeRequest_NoFastForward()
    {
        var sha = new CommitSha("abcdef0123456789abcdef0123456789abcdef01");
        var req = new MergeRequest
        {
            Source = sha,
            Principal = TestPrincipal,
            Message = "merge commit",
            NoFastForward = true,
        };

        Assert.Equal("merge commit", req.Message);
        Assert.True(req.NoFastForward);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // WorktreeRequest
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void WorktreeRequest_ConstructsCorrectly()
    {
        var req = new WorktreeRequest
        {
            Path = new AbsolutePath("/tmp/wt"),
            Branch = "feature/test",
            CreateBranch = true,
            Lock = false,
        };

        Assert.Equal("/tmp/wt", req.Path.Value);
        Assert.Equal("feature/test", req.Branch);
        Assert.True(req.CreateBranch);
        Assert.False(req.Lock);
    }
}
