// <copyright file="ResultTypeTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Git.Results;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;
using Xunit;

namespace AiOrchestrator.Git.Tests;

/// <summary>Tests for Git result type construction and record equality.</summary>
public sealed class ResultTypeTests
{
    // ──────────────────────────────────────────────────────────────────────────
    // CloneResult
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void CloneResult_ConstructsCorrectly()
    {
        var path = new AbsolutePath("/tmp/repo");
        var sha = new CommitSha("abcdef0123456789abcdef0123456789abcdef01");
        var result = new CloneResult(path, sha);

        Assert.Equal(path, result.LocalPath);
        Assert.Equal(sha, result.HeadSha);
    }

    [Fact]
    public void CloneResult_RecordEquality()
    {
        var path = new AbsolutePath("/tmp/repo");
        var sha = new CommitSha("abcdef0123456789abcdef0123456789abcdef01");

        var a = new CloneResult(path, sha);
        var b = new CloneResult(path, sha);

        Assert.Equal(a, b);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // FetchResult
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void FetchResult_ConstructsCorrectly()
    {
        var result = new FetchResult(42, 1024);

        Assert.Equal(42, result.ObjectsReceived);
        Assert.Equal(1024L, result.BytesReceived);
    }

    [Fact]
    public void FetchResult_RecordEquality()
    {
        var a = new FetchResult(10, 500);
        var b = new FetchResult(10, 500);

        Assert.Equal(a, b);
    }

    [Fact]
    public void FetchResult_DifferentValues_NotEqual()
    {
        var a = new FetchResult(10, 500);
        var b = new FetchResult(20, 500);

        Assert.NotEqual(a, b);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // MergeResult
    // ──────────────────────────────────────────────────────────────────────────

    [Theory]
    [InlineData(MergeOutcome.UpToDate)]
    [InlineData(MergeOutcome.FastForward)]
    [InlineData(MergeOutcome.NonFastForward)]
    public void MergeResult_AllOutcomes(MergeOutcome outcome)
    {
        var sha = new CommitSha("abcdef0123456789abcdef0123456789abcdef01");
        var result = new MergeResult(outcome, sha);

        Assert.Equal(outcome, result.Outcome);
        Assert.Equal(sha, result.HeadSha);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // PushResult
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void PushResult_ConstructsCorrectly()
    {
        var refs = ImmutableArray.Create("refs/heads/main", "refs/heads/feature");
        var result = new PushResult(refs);

        Assert.Equal(2, result.UpdatedRefs.Length);
        Assert.Contains("refs/heads/main", result.UpdatedRefs);
        Assert.Contains("refs/heads/feature", result.UpdatedRefs);
    }

    [Fact]
    public void PushResult_Empty()
    {
        var result = new PushResult(ImmutableArray<string>.Empty);

        Assert.Empty(result.UpdatedRefs);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // RefUpdate
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void RefUpdate_ConstructsCorrectly()
    {
        var old = new CommitSha("0000000000000000000000000000000000000000");
        var @new = new CommitSha("1111111111111111111111111111111111111111");
        var result = new RefUpdate("refs/heads/main", old, @new);

        Assert.Equal("refs/heads/main", result.RefName);
        Assert.Equal(old, result.OldTarget);
        Assert.Equal(@new, result.NewTarget);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // DiffResult / DiffEntry
    // ──────────────────────────────────────────────────────────────────────────

    [Theory]
    [InlineData(DiffStatus.Added)]
    [InlineData(DiffStatus.Modified)]
    [InlineData(DiffStatus.Deleted)]
    [InlineData(DiffStatus.Renamed)]
    public void DiffEntry_AllStatuses(DiffStatus status)
    {
        var entry = new DiffEntry(
            new RepoRelativePath("src/file.cs"),
            status == DiffStatus.Renamed ? new RepoRelativePath("src/old.cs") : null,
            status);

        Assert.Equal(status, entry.Status);
        Assert.Equal("src/file.cs", entry.Path.Value);
    }

    [Fact]
    public void DiffResult_ConstructsWithEntries()
    {
        var entries = ImmutableArray.Create(
            new DiffEntry(new RepoRelativePath("a.cs"), null, DiffStatus.Added),
            new DiffEntry(new RepoRelativePath("b.cs"), null, DiffStatus.Modified));

        var result = new DiffResult(entries);

        Assert.Equal(2, result.Entries.Length);
    }

    [Fact]
    public void DiffResult_Empty()
    {
        var result = new DiffResult(ImmutableArray<DiffEntry>.Empty);

        Assert.Empty(result.Entries);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // CommitInfo
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void CommitInfo_ConstructsCorrectly()
    {
        var sha = new CommitSha("abcdef0123456789abcdef0123456789abcdef01");
        var now = DateTimeOffset.UtcNow;
        var info = new CommitInfo(
            sha, "feat: add feature", "Alice", "alice@example.com", now,
            "Bob", "bob@example.com", now);

        Assert.Equal(sha, info.Sha);
        Assert.Equal("feat: add feature", info.Message);
        Assert.Equal("Alice", info.AuthorName);
        Assert.Equal("alice@example.com", info.AuthorEmail);
        Assert.Equal(now, info.AuthorDateUtc);
        Assert.Equal("Bob", info.CommitterName);
        Assert.Equal("bob@example.com", info.CommitterEmail);
        Assert.Equal(now, info.CommitterDateUtc);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ShellResult
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void ShellResult_ConstructsCorrectly()
    {
        var result = new Shell.ShellResult(0, "output", "");

        Assert.Equal(0, result.ExitCode);
        Assert.Equal("output", result.StandardOutput);
        Assert.Equal("", result.StandardError);
    }

    [Fact]
    public void ShellResult_RecordEquality()
    {
        var a = new Shell.ShellResult(1, "out", "err");
        var b = new Shell.ShellResult(1, "out", "err");

        Assert.Equal(a, b);
    }
}
