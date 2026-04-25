// <copyright file="GitOperationsCoverageTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Git.Exceptions;
using AiOrchestrator.Git.Requests;
using AiOrchestrator.Git.Results;
using AiOrchestrator.Git.Shell;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;
using Xunit;

namespace AiOrchestrator.Git.Tests;

/// <summary>
/// Coverage-focused tests for <see cref="GitOperations"/> methods that are
/// not yet exercised by <see cref="GitContractTests"/>.
/// Targets: StatusAsync, CommitAsync, GetHeadShaAsync, ResetHardAsync,
/// MergeAsync (simple), DiffAsync, WalkAsync, OpenAsync error path,
/// AddWorktreeAsync error path, RemoveWorktreeAsync, DisposeAsync,
/// CreateCommitAsync with explicit committer, and worktree-without-lock.
/// </summary>
public sealed class GitOperationsCoverageTests
{
    private static readonly IFileSystem NullFs = null!;

    // ──────────────────────────────────────────────────────────────────────────
    // OpenAsync
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task OpenAsync_ValidRepo_ReturnsHandle()
    {
        using var repo = new TestRepo();
        repo.WriteAndCommit("seed.txt", "seed");

        var ops = CreateOps();
        using var handle = await ops.OpenAsync(repo.Root, default);

        Assert.Equal(repo.Root, handle.Path);
    }

    [Fact]
    public async Task OpenAsync_InvalidPath_ThrowsGitOperationException()
    {
        var ops = CreateOps();
        var badPath = new AbsolutePath(Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N")));

        var ex = await Assert.ThrowsAnyAsync<GitOperationException>(
            () => ops.OpenAsync(badPath, default).AsTask());
        Assert.NotNull(ex);
    }

    [Fact]
    public async Task OpenAsync_CancelledToken_ThrowsOCE()
    {
        using var repo = new TestRepo();
        repo.WriteAndCommit("seed.txt", "seed");

        var ops = CreateOps();
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => ops.OpenAsync(repo.Root, cts.Token).AsTask());
    }

    // ──────────────────────────────────────────────────────────────────────────
    // StatusAsync (simple API)
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task StatusAsync_CleanRepo_ReportsNotDirty()
    {
        using var repo = new TestRepo();
        repo.WriteAndCommit("a.txt", "hello");

        var ops = CreateOps();
        var status = await ops.StatusAsync(repo.Root, default);

        Assert.False(status.HasUncommittedChanges);
        Assert.Equal("master", status.Branch);
    }

    [Fact]
    public async Task StatusAsync_DirtyRepo_ReportsIsDirty()
    {
        using var repo = new TestRepo();
        repo.WriteAndCommit("a.txt", "hello");
        // Make the repo dirty by writing an unstaged file.
        File.WriteAllText(Path.Combine(repo.Root.Value, "dirty.txt"), "uncommitted");

        var ops = CreateOps();
        var status = await ops.StatusAsync(repo.Root, default);

        Assert.True(status.HasUncommittedChanges);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // CommitAsync (simple API)
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task CommitAsync_CreatesNewCommit()
    {
        using var repo = new TestRepo();
        repo.WriteAndCommit("seed.txt", "seed");

        // Stage a new file so the commit is non-empty.
        File.WriteAllText(Path.Combine(repo.Root.Value, "new.txt"), "content");
        using (var lg = new LibGit2Sharp.Repository(repo.Root.Value))
        {
            LibGit2Sharp.Commands.Stage(lg, "new.txt");
        }

        var ops = CreateOps();
        var sha = await ops.CommitAsync(repo.Root, "test commit", Mocks.TestPrincipal, default);

        Assert.NotNull(sha);
        Assert.Equal(40, sha.Hex.Length);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // GetHeadShaAsync
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task GetHeadShaAsync_ReturnsSha()
    {
        using var repo = new TestRepo();
        var expected = repo.WriteAndCommit("a.txt", "x");

        var ops = CreateOps();
        var head = await ops.GetHeadShaAsync(repo.Root, default);

        Assert.Equal(expected, head.Hex);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ResetHardAsync
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task ResetHardAsync_ResetsToOlderCommit()
    {
        using var repo = new TestRepo();
        var first = repo.WriteAndCommit("a.txt", "1", "first");
        _ = repo.WriteAndCommit("b.txt", "2", "second");

        var ops = CreateOps();
        await ops.ResetHardAsync(repo.Root, new CommitSha(first), default);

        var head = await ops.GetHeadShaAsync(repo.Root, default);
        Assert.Equal(first, head.Hex);
    }

    [Fact]
    public async Task ResetHardAsync_NonExistentSha_Throws()
    {
        using var repo = new TestRepo();
        repo.WriteAndCommit("a.txt", "x");

        var ops = CreateOps();
        var bogus = new CommitSha("0000000000000000000000000000000000000000");

        await Assert.ThrowsAsync<RefNotFoundException>(
            () => ops.ResetHardAsync(repo.Root, bogus, default).AsTask());
    }

    // ──────────────────────────────────────────────────────────────────────────
    // MergeAsync (simple API)
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task MergeAsync_SimpleFastForward()
    {
        using var repo = new TestRepo();
        repo.WriteAndCommit("seed.txt", "seed");

        // Create a branch and add a commit.
        using (var lg = new LibGit2Sharp.Repository(repo.Root.Value))
        {
            var tip = lg.Head.Tip;
            lg.Branches.Add("feature", tip);
        }

        // Checkout master, write on feature branch using libgit2.
        using (var lg = new LibGit2Sharp.Repository(repo.Root.Value))
        {
            var branch = lg.Branches["feature"];
            LibGit2Sharp.Commands.Checkout(lg, branch);
        }

        File.WriteAllText(Path.Combine(repo.Root.Value, "feat.txt"), "feature work");
        using (var lg = new LibGit2Sharp.Repository(repo.Root.Value))
        {
            LibGit2Sharp.Commands.Stage(lg, "feat.txt");
            var sig = new LibGit2Sharp.Signature("tester", "t@t.com", DateTimeOffset.UtcNow);
            lg.Commit("feature commit", sig, sig, new LibGit2Sharp.CommitOptions());
        }

        // Switch back to master.
        using (var lg = new LibGit2Sharp.Repository(repo.Root.Value))
        {
            LibGit2Sharp.Commands.Checkout(lg, lg.Branches["master"]);
        }

        var ops = CreateOps();
        await ops.MergeAsync(repo.Root, "feature", default);

        // After merge, HEAD should have the feature file.
        Assert.True(File.Exists(Path.Combine(repo.Root.Value, "feat.txt")));
    }

    [Fact]
    public async Task MergeAsync_NonExistentBranch_Throws()
    {
        using var repo = new TestRepo();
        repo.WriteAndCommit("seed.txt", "seed");

        var ops = CreateOps();

        await Assert.ThrowsAsync<RefNotFoundException>(
            () => ops.MergeAsync(repo.Root, "no-such-branch", default).AsTask());
    }

    // ──────────────────────────────────────────────────────────────────────────
    // DiffAsync (rich API)
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task DiffAsync_DetectsAddedFiles()
    {
        using var repo = new TestRepo();
        var sha1 = repo.WriteAndCommit("a.txt", "1", "first");
        var sha2 = repo.WriteAndCommit("b.txt", "2", "second");

        var ops = CreateOps();
        using var handle = await ops.OpenAsync(repo.Root, default);
        var diff = await ops.DiffAsync(handle, new DiffRequest { From = new CommitSha(sha1), To = new CommitSha(sha2) }, default);

        Assert.Single(diff.Entries);
        Assert.Equal("b.txt", diff.Entries[0].Path.Value);
        Assert.Equal(DiffStatus.Added, diff.Entries[0].Status);
    }

    [Fact]
    public async Task DiffAsync_DetectsModifiedFiles()
    {
        using var repo = new TestRepo();
        var sha1 = repo.WriteAndCommit("a.txt", "version1", "first");
        var sha2 = repo.WriteAndCommit("a.txt", "version2", "second");

        var ops = CreateOps();
        using var handle = await ops.OpenAsync(repo.Root, default);
        var diff = await ops.DiffAsync(handle, new DiffRequest { From = new CommitSha(sha1), To = new CommitSha(sha2) }, default);

        Assert.Single(diff.Entries);
        Assert.Equal(DiffStatus.Modified, diff.Entries[0].Status);
    }

    [Fact]
    public async Task DiffAsync_DetectsDeletedFiles()
    {
        using var repo = new TestRepo();
        var sha1 = repo.WriteAndCommit("del.txt", "will-be-deleted", "add");
        // Delete the file and commit the deletion.
        File.Delete(Path.Combine(repo.Root.Value, "del.txt"));
        using (var lg = new LibGit2Sharp.Repository(repo.Root.Value))
        {
            LibGit2Sharp.Commands.Stage(lg, "del.txt");
            var sig = new LibGit2Sharp.Signature("tester", "t@t.com", DateTimeOffset.UtcNow);
            lg.Commit("remove del.txt", sig, sig, new LibGit2Sharp.CommitOptions());
        }

        string sha2;
        using (var lg = new LibGit2Sharp.Repository(repo.Root.Value))
        {
            sha2 = lg.Head.Tip.Sha;
        }

        var ops = CreateOps();
        using var handle = await ops.OpenAsync(repo.Root, default);
        var diff = await ops.DiffAsync(handle, new DiffRequest { From = new CommitSha(sha1), To = new CommitSha(sha2) }, default);

        Assert.Single(diff.Entries);
        Assert.Equal(DiffStatus.Deleted, diff.Entries[0].Status);
    }

    [Fact]
    public async Task DiffAsync_EmptyDiff_ReturnsEmpty()
    {
        using var repo = new TestRepo();
        var sha = repo.WriteAndCommit("a.txt", "x");

        var ops = CreateOps();
        using var handle = await ops.OpenAsync(repo.Root, default);
        var diff = await ops.DiffAsync(handle, new DiffRequest { From = new CommitSha(sha), To = new CommitSha(sha) }, default);

        Assert.Empty(diff.Entries);
    }

    [Fact]
    public async Task DiffAsync_InvalidSha_ThrowsRefNotFound()
    {
        using var repo = new TestRepo();
        var sha = repo.WriteAndCommit("a.txt", "x");

        var ops = CreateOps();
        using var handle = await ops.OpenAsync(repo.Root, default);
        var bogus = new CommitSha("0000000000000000000000000000000000000000");

        await Assert.ThrowsAsync<RefNotFoundException>(
            () => ops.DiffAsync(handle, new DiffRequest { From = bogus, To = new CommitSha(sha) }, default).AsTask());
    }

    [Fact]
    public async Task DiffAsync_NullRequest_Throws()
    {
        using var repo = new TestRepo();
        repo.WriteAndCommit("a.txt", "x");

        var ops = CreateOps();
        using var handle = await ops.OpenAsync(repo.Root, default);

        await Assert.ThrowsAsync<ArgumentNullException>(
            () => ops.DiffAsync(handle, null!, default).AsTask());
    }

    [Fact]
    public async Task DiffAsync_NullRepo_Throws()
    {
        var ops = CreateOps();

        await Assert.ThrowsAsync<ArgumentNullException>(
            () => ops.DiffAsync(null!, new DiffRequest { From = new CommitSha("a" + new string('0', 39)), To = new CommitSha("b" + new string('0', 39)) }, default).AsTask());
    }

    [Fact]
    public async Task DiffAsync_CancelledToken_Throws()
    {
        using var repo = new TestRepo();
        var sha = repo.WriteAndCommit("a.txt", "x");

        var ops = CreateOps();
        using var handle = await ops.OpenAsync(repo.Root, default);
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => ops.DiffAsync(handle, new DiffRequest { From = new CommitSha(sha), To = new CommitSha(sha) }, cts.Token).AsTask());
    }

    // ──────────────────────────────────────────────────────────────────────────
    // WalkAsync
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task WalkAsync_WalksAllCommits()
    {
        using var repo = new TestRepo();
        repo.WriteAndCommit("a.txt", "1", "first");
        var sha2 = repo.WriteAndCommit("b.txt", "2", "second");

        var ops = CreateOps();
        using var handle = await ops.OpenAsync(repo.Root, default);

        var commits = new List<CommitInfo>();
        await foreach (var c in ops.WalkAsync(handle, new WalkRequest { From = new CommitSha(sha2) }, default))
        {
            commits.Add(c);
        }

        Assert.Equal(2, commits.Count);
        Assert.Equal("second", commits[0].Message.TrimEnd('\n'));
    }

    [Fact]
    public async Task WalkAsync_WithLimit_RespectsLimit()
    {
        using var repo = new TestRepo();
        repo.WriteAndCommit("a.txt", "1", "first");
        repo.WriteAndCommit("b.txt", "2", "second");
        var sha3 = repo.WriteAndCommit("c.txt", "3", "third");

        var ops = CreateOps();
        using var handle = await ops.OpenAsync(repo.Root, default);

        var commits = new List<CommitInfo>();
        await foreach (var c in ops.WalkAsync(handle, new WalkRequest { From = new CommitSha(sha3), Limit = 2 }, default))
        {
            commits.Add(c);
        }

        Assert.Equal(2, commits.Count);
    }

    [Fact]
    public async Task WalkAsync_WithUntil_ExcludesOlderCommits()
    {
        using var repo = new TestRepo();
        var sha1 = repo.WriteAndCommit("a.txt", "1", "first");
        repo.WriteAndCommit("b.txt", "2", "second");
        var sha3 = repo.WriteAndCommit("c.txt", "3", "third");

        var ops = CreateOps();
        using var handle = await ops.OpenAsync(repo.Root, default);

        var commits = new List<CommitInfo>();
        await foreach (var c in ops.WalkAsync(handle, new WalkRequest { From = new CommitSha(sha3), Until = new CommitSha(sha1) }, default))
        {
            commits.Add(c);
        }

        // sha1 is excluded, so only "second" and "third" should appear.
        Assert.Equal(2, commits.Count);
    }

    [Fact]
    public async Task WalkAsync_CancelledMidWalk_Throws()
    {
        using var repo = new TestRepo();
        repo.WriteAndCommit("a.txt", "1");
        repo.WriteAndCommit("b.txt", "2");
        var sha = repo.WriteAndCommit("c.txt", "3");

        var ops = CreateOps();
        using var handle = await ops.OpenAsync(repo.Root, default);
        using var cts = new CancellationTokenSource();

        var enumerator = ops.WalkAsync(handle, new WalkRequest { From = new CommitSha(sha) }, cts.Token).GetAsyncEnumerator(cts.Token);
        Assert.True(await enumerator.MoveNextAsync());
        cts.Cancel();

        await Assert.ThrowsAsync<OperationCanceledException>(async () =>
        {
            while (await enumerator.MoveNextAsync())
            {
                // drain
            }
        });
    }

    // ──────────────────────────────────────────────────────────────────────────
    // CreateCommitAsync (rich API) — committer variant
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task CreateCommitAsync_WithExplicitCommitter()
    {
        using var repo = new TestRepo();
        repo.WriteAndCommit("seed.txt", "seed");

        var ops = CreateOps();
        using var handle = await ops.OpenAsync(repo.Root, default);

        var committer = new Models.Auth.AuthContext
        {
            PrincipalId = "committer@example.com",
            DisplayName = "Committer",
            Scopes = ImmutableArray<string>.Empty,
        };

        var info = await ops.CreateCommitAsync(handle, new CommitRequest
        {
            Message = "with-committer",
            Author = Mocks.TestPrincipal,
            Committer = committer,
            AllowEmpty = true,
        }, default);

        Assert.Equal("Committer", info.CommitterName);
        Assert.Equal("committer@example.com", info.CommitterEmail);
        Assert.Equal("tester", info.AuthorName);
    }

    [Fact]
    public async Task CreateCommitAsync_NullRepo_Throws()
    {
        var ops = CreateOps();

        await Assert.ThrowsAsync<ArgumentNullException>(
            () => ops.CreateCommitAsync(null!, new CommitRequest { Message = "x", Author = Mocks.TestPrincipal, AllowEmpty = true }, default).AsTask());
    }

    [Fact]
    public async Task CreateCommitAsync_NullRequest_Throws()
    {
        using var repo = new TestRepo();
        repo.WriteAndCommit("seed.txt", "seed");

        var ops = CreateOps();
        using var handle = await ops.OpenAsync(repo.Root, default);

        await Assert.ThrowsAsync<ArgumentNullException>(
            () => ops.CreateCommitAsync(handle, null!, default).AsTask());
    }

    [Fact]
    public async Task CreateCommitAsync_CancelledToken_Throws()
    {
        using var repo = new TestRepo();
        repo.WriteAndCommit("seed.txt", "seed");

        var ops = CreateOps();
        using var handle = await ops.OpenAsync(repo.Root, default);
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => ops.CreateCommitAsync(handle, new CommitRequest { Message = "x", Author = Mocks.TestPrincipal, AllowEmpty = true }, cts.Token).AsTask());
    }

    // ──────────────────────────────────────────────────────────────────────────
    // AddWorktreeAsync — error path and without CreateBranch/Lock
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task AddWorktreeAsync_NonZeroExit_ThrowsWorktreeLockedException()
    {
        using var repo = new TestRepo();
        repo.WriteAndCommit("seed.txt", "seed");

        var spawner = new StubProcessSpawner
        {
            Factory = _ => new FakeProcessHandle(128, string.Empty, "fatal: unable to create worktree"),
        };

        var ops = CreateOps(spawner);
        using var handle = await ops.OpenAsync(repo.Root, default);
        var wtPath = new AbsolutePath(Path.Combine(Path.GetTempPath(), "wt-" + Guid.NewGuid().ToString("N")));

        var ex = await Assert.ThrowsAsync<WorktreeLockedException>(
            () => ops.AddWorktreeAsync(handle, new WorktreeRequest { Path = wtPath, Branch = "wip", CreateBranch = true }, default).AsTask());

        Assert.Equal(wtPath, ex.WorktreePath);
        Assert.Contains("fatal", ex.LockReason);
    }

    [Fact]
    public async Task AddWorktreeAsync_WithoutCreateBranch_ChecksBranchArgs()
    {
        using var repo = new TestRepo();
        repo.WriteAndCommit("seed.txt", "seed");

        // Create the branch so it exists for the non-CreateBranch path.
        using (var lg = new LibGit2Sharp.Repository(repo.Root.Value))
        {
            lg.Branches.Add("existing", lg.Head.Tip);
        }

        var spawner = new StubProcessSpawner
        {
            Factory = _ => new FakeProcessHandle(0, string.Empty, string.Empty),
        };

        var ops = CreateOps(spawner);
        using var handle = await ops.OpenAsync(repo.Root, default);
        var wtPath = new AbsolutePath(Path.Combine(Path.GetTempPath(), "wt-" + Guid.NewGuid().ToString("N")));

        var wt = await ops.AddWorktreeAsync(handle, new WorktreeRequest { Path = wtPath, Branch = "existing", CreateBranch = false, Lock = false }, default);

        // Verify shell args don't include -b or --lock.
        Assert.DoesNotContain("-b", spawner.Calls[0].Arguments);
        Assert.DoesNotContain("--lock", spawner.Calls[0].Arguments);
        Assert.Contains("add", spawner.Calls[0].Arguments);
        Assert.Contains(wtPath.Value, spawner.Calls[0].Arguments);
        Assert.Contains("existing", spawner.Calls[0].Arguments);

        await wt.DisposeAsync();
    }

    [Fact]
    public async Task AddWorktreeAsync_NullRepo_Throws()
    {
        var ops = CreateOps();

        await Assert.ThrowsAsync<ArgumentNullException>(
            () => ops.AddWorktreeAsync(null!, new WorktreeRequest { Path = new AbsolutePath("/tmp/wt"), Branch = "x" }, default).AsTask());
    }

    [Fact]
    public async Task AddWorktreeAsync_NullRequest_Throws()
    {
        using var repo = new TestRepo();
        repo.WriteAndCommit("seed.txt", "seed");

        var ops = CreateOps();
        using var handle = await ops.OpenAsync(repo.Root, default);

        await Assert.ThrowsAsync<ArgumentNullException>(
            () => ops.AddWorktreeAsync(handle, null!, default).AsTask());
    }

    // ──────────────────────────────────────────────────────────────────────────
    // RemoveWorktreeAsync (simple API)
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task RemoveWorktreeAsync_RunsShellCommand()
    {
        using var repo = new TestRepo();
        repo.WriteAndCommit("seed.txt", "seed");

        var spawner = new StubProcessSpawner
        {
            Factory = _ => new FakeProcessHandle(0, string.Empty, string.Empty),
        };

        var ops = CreateOps(spawner);
        var wtPath = new AbsolutePath(Path.Combine(Path.GetTempPath(), "wt-" + Guid.NewGuid().ToString("N")));

        await ops.RemoveWorktreeAsync(repo.Root, wtPath, default);

        Assert.Single(spawner.Calls);
        Assert.Contains("remove", spawner.Calls[0].Arguments);
        Assert.Contains("--force", spawner.Calls[0].Arguments);
        Assert.Contains(wtPath.Value, spawner.Calls[0].Arguments);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // FetchAsync (simple API) — error path (no remote)
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task FetchAsync_Simple_NoRemote_ThrowsRefNotFound()
    {
        using var repo = new TestRepo();
        repo.WriteAndCommit("seed.txt", "seed");

        var ops = CreateOps();

        // Local-only repo has no "origin" remote.
        await Assert.ThrowsAsync<RefNotFoundException>(
            () => ops.FetchAsync(repo.Root, "origin", default).AsTask());
    }

    // ──────────────────────────────────────────────────────────────────────────
    // UpdateRefAsync — additional null/arg checks
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task UpdateRefAsync_NullRepo_Throws()
    {
        var ops = CreateOps();
        var sha = new CommitSha("a" + new string('0', 39));

        await Assert.ThrowsAsync<ArgumentNullException>(
            () => ops.UpdateRefAsync(null!, "refs/heads/main", sha, sha, default).AsTask());
    }

    [Fact]
    public async Task UpdateRefAsync_EmptyRefName_Throws()
    {
        using var repo = new TestRepo();
        repo.WriteAndCommit("seed.txt", "seed");

        var ops = CreateOps();
        using var handle = await ops.OpenAsync(repo.Root, default);
        var sha = new CommitSha("a" + new string('0', 39));

        await Assert.ThrowsAsync<ArgumentException>(
            () => ops.UpdateRefAsync(handle, "", sha, sha, default).AsTask());
    }

    [Fact]
    public async Task UpdateRefAsync_HappyPath()
    {
        using var repo = new TestRepo();
        var sha1 = repo.WriteAndCommit("a.txt", "1", "first");
        var sha2 = repo.WriteAndCommit("b.txt", "2", "second");

        var ops = CreateOps();
        using var handle = await ops.OpenAsync(repo.Root, default);

        var result = await ops.UpdateRefAsync(
            handle,
            "refs/heads/master",
            new CommitSha(sha1),
            new CommitSha(sha2), // current is sha2
            default);

        Assert.Equal("refs/heads/master", result.RefName);
        Assert.Equal(sha2, result.OldTarget.Hex);
        Assert.Equal(sha1, result.NewTarget.Hex);
    }

    [Fact]
    public async Task UpdateRefAsync_NonExistentRef_ThrowsRefNotFound()
    {
        using var repo = new TestRepo();
        var sha = repo.WriteAndCommit("a.txt", "1");

        var ops = CreateOps();
        using var handle = await ops.OpenAsync(repo.Root, default);

        await Assert.ThrowsAsync<RefNotFoundException>(
            () => ops.UpdateRefAsync(handle, "refs/heads/no-such-branch", new CommitSha(sha), new CommitSha(sha), default).AsTask());
    }

    // ──────────────────────────────────────────────────────────────────────────
    // DisposeAsync
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task DisposeAsync_IsIdempotent()
    {
        var ops = CreateOps();
        await ops.DisposeAsync();
        await ops.DisposeAsync(); // should not throw
    }

    // ──────────────────────────────────────────────────────────────────────────
    // CreateWorktreeAsync (simple API)
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task CreateWorktreeAsync_Simple_CallsShell()
    {
        using var repo = new TestRepo();
        repo.WriteAndCommit("seed.txt", "seed");

        var spawner = new StubProcessSpawner
        {
            Factory = _ => new FakeProcessHandle(0, string.Empty, string.Empty),
        };

        var ops = CreateOps(spawner);
        var wtPath = new AbsolutePath(Path.Combine(Path.GetTempPath(), "wt-" + Guid.NewGuid().ToString("N")));

        await ops.CreateWorktreeAsync(repo.Root, wtPath, "test-branch", default);

        Assert.NotEmpty(spawner.Calls);
        Assert.Contains("add", spawner.Calls[0].Arguments);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // GitShellInvoker — additional verb mapping coverage
    // ──────────────────────────────────────────────────────────────────────────

    [Theory]
    [InlineData(GitVerb.SparseCheckout)]
    [InlineData(GitVerb.CommitGraph)]
    [InlineData(GitVerb.FsMonitor)]
    [InlineData(GitVerb.MaintenanceRun)]
    public async Task ShellInvoker_AllVerbs_RunSuccessfully(GitVerb verb)
    {
        var spawner = new StubProcessSpawner
        {
            Factory = _ => new FakeProcessHandle(0, "ok", string.Empty),
        };
        var invoker = new GitShellInvoker(spawner, Mocks.Opts());

        var result = await invoker.RunAsync(verb, ImmutableArray<string>.Empty, new AbsolutePath(Path.GetTempPath()), default);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal("ok", result.StandardOutput);
    }

    [Fact]
    public async Task ShellInvoker_CustomGitExecutable()
    {
        var spawner = new StubProcessSpawner
        {
            Factory = _ => new FakeProcessHandle(0, string.Empty, string.Empty),
        };
        var opts = new GitOptions { GitExecutable = new AbsolutePath("/custom/git") };
        var invoker = new GitShellInvoker(spawner, Mocks.Opts(opts));

        await invoker.RunAsync(GitVerb.Worktree, ImmutableArray.Create("list"), new AbsolutePath(Path.GetTempPath()), default);

        Assert.Equal("/custom/git", spawner.Calls[0].Executable);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // WorktreeHandle — idempotent dispose
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task WorktreeHandle_DoubleDispose_IsIdempotent()
    {
        using var repo = new TestRepo();
        repo.WriteAndCommit("seed.txt", "seed");

        var spawner = new StubProcessSpawner
        {
            Factory = _ => new FakeProcessHandle(0, string.Empty, string.Empty),
        };

        var ops = CreateOps(spawner);
        using var handle = await ops.OpenAsync(repo.Root, default);
        var wtPath = new AbsolutePath(Path.Combine(Path.GetTempPath(), "wt-" + Guid.NewGuid().ToString("N")));

        var wt = await ops.AddWorktreeAsync(handle, new WorktreeRequest { Path = wtPath, Branch = "wip", CreateBranch = true }, default);

        await wt.DisposeAsync();
        await wt.DisposeAsync(); // should not throw or spawn again

        // Should only spawn twice: add + first remove (second dispose is no-op).
        Assert.Equal(2, spawner.Calls.Count);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Helpers
    // ──────────────────────────────────────────────────────────────────────────

    private static GitOperations CreateOps(StubProcessSpawner? spawner = null)
    {
        spawner ??= new StubProcessSpawner
        {
            Factory = _ => new FakeProcessHandle(0, string.Empty, string.Empty),
        };

        return new GitOperations(
            new StubCredentialBroker(),
            spawner,
            NullFs,
            new TestClock(),
            Mocks.Opts(),
            Mocks.NullLog);
    }
}
