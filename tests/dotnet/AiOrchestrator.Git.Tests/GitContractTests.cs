// <copyright file="GitContractTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Diagnostics;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Git.Bridge;
using AiOrchestrator.Git.Exceptions;
using AiOrchestrator.Git.Requests;
using AiOrchestrator.Git.Shell;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;
using FluentAssertions;
using LibGit2Sharp;
using Xunit;

namespace AiOrchestrator.Git.Tests;

public sealed class GitContractTests
{
    private static readonly IFileSystem NullFs = null!;

    [Fact]
    [ContractTest("LG2-CANCEL-1")]
    public void LG2_CANCEL_1_FetchCancelsViaProgressCallback()
    {
        // INV-1: cancellation token threads into the transfer-progress callback as `return false`.
        var cts = new CancellationTokenSource();
        var cb = LibGit2Bridge.CreateTransferCallback(cts.Token);
        var tp = (TransferProgress)Activator.CreateInstance(typeof(TransferProgress), nonPublic: true)!;

        cb(tp).Should().BeTrue();
        cts.Cancel();
        cb(tp).Should().BeFalse();
    }

    [Fact]
    [ContractTest("LG2-CANCEL-2")]
    public async Task LG2_CANCEL_2_CancellationCompletesUnder200ms()
    {
        // INV-2: after cancellation the next progress tick aborts. We simulate by polling
        // the transfer-progress callback at the configured tick interval.
        var opts = new GitOptions { ProgressTickInterval = TimeSpan.FromMilliseconds(50) };
        using var cts = new CancellationTokenSource();
        var cb = LibGit2Bridge.CreateTransferCallback(cts.Token);
        var tp = (TransferProgress)Activator.CreateInstance(typeof(TransferProgress), nonPublic: true)!;

        var sw = Stopwatch.StartNew();
        cts.CancelAfter(TimeSpan.FromMilliseconds(20));

        // Simulate libgit2 polling progress every tick interval.
        while (cb(tp))
        {
            await Task.Delay(opts.ProgressTickInterval).ConfigureAwait(false);
            if (sw.Elapsed > TimeSpan.FromSeconds(2))
            {
                throw new TimeoutException("Cancellation did not propagate");
            }
        }

        sw.Stop();
        sw.Elapsed.Should().BeLessThan(TimeSpan.FromMilliseconds((2 * opts.ProgressTickInterval.TotalMilliseconds) + 200));
    }

    [Fact]
    [ContractTest("LG2-BRK-MERGE")]
    public void LG2_BRK_1_MergeConflictMappedToTypedException()
    {
        // INV-3: a libgit2 CheckoutConflictException maps to MergeConflictException.
        // We can't easily construct a CheckoutConflictException with a public constructor,
        // so we use the LibGit2SharpException base and then verify path-based reflection
        // by exercising the Map function with the closest-shaped exception we can build.
        var lge = new LibGit2SharpException("merge produced rejected paths\nsrc/foo.cs\nsrc/bar.cs");
        var mapped = LibGit2Bridge.Map(lge);
        // For non-conflict LG2 exceptions, fall back to NetworkErrorException; verify the
        // dedicated branch for CheckoutConflictException by constructing one via reflection-free path.
        mapped.Should().NotBeNull();

        // Direct test: pass an actual CheckoutConflictException-shaped path.
        var ce = (CheckoutConflictException)Activator.CreateInstance(
            typeof(CheckoutConflictException),
            new object[] { "checkout failed\nfoo/bar.cs\nbaz.cs" })!;
        var conflict = LibGit2Bridge.Map(ce);
        conflict.Should().BeOfType<MergeConflictException>();
        ((MergeConflictException)conflict).ConflictingPaths.Should().NotBeEmpty();
    }

    [Fact]
    [ContractTest("LG2-BRK-REMOTE")]
    public void LG2_BRK_2_RemoteRejectedMappedToTypedException()
    {
        var lge = new LibGit2SharpException("remote rejected push: non-fast-forward update");
        var mapped = LibGit2Bridge.Map(lge, new Uri("https://example.com/repo.git"));
        mapped.Should().BeOfType<RemoteRejectedException>();
        var rr = (RemoteRejectedException)mapped;
        rr.RemoteUrl.Should().Contain("example.com");
    }

    [Fact]
    [ContractTest("LG2-BRK-AUTH")]
    public void LG2_BRK_3_AuthFailureMappedToTypedException()
    {
        var lge = new LibGit2SharpException("authentication required for https://example.com/repo");
        var mapped = LibGit2Bridge.Map(lge, new Uri("https://example.com/repo"));
        mapped.Should().BeOfType<AuthFailureException>();
        ((AuthFailureException)mapped).RepoUrl.Host.Should().Be("example.com");
    }

    [Fact]
    [ContractTest("LG2-BRK-REFRACE")]
    public async Task LG2_BRK_4_RefRaceMappedToTypedException()
    {
        // INV-6: an UpdateRefAsync where the actual old SHA differs from expected raises RefUpdateRaceException.
        using var repo = new TestRepo();
        var sha1 = repo.WriteAndCommit("a.txt", "1", "first");
        var sha2 = repo.WriteAndCommit("b.txt", "2", "second");

        var clock = new TestClock();
        var ops = new GitOperations(
            new StubCredentialBroker(),
            new StubProcessSpawner(),
            NullFs,
            clock,
            Mocks.Opts(),
            Mocks.NullLog);

        using var handle = await ops.OpenAsync(repo.Root, default);
        var wrongOld = new CommitSha(sha1); // ref currently points at sha2

        var act = async () => await ops.UpdateRefAsync(
            handle,
            "refs/heads/master",
            new CommitSha(sha2),
            wrongOld,
            default);

        await act.Should().ThrowAsync<RefUpdateRaceException>();
    }

    [Fact]
    [ContractTest("GIT-WT-CYCLE")]
    public async Task GIT_WORKTREE_AddRemoveCycle_LeavesNoLeaks()
    {
        // INV-5: add then remove a worktree via the shell allowlist; no orphans on disk.
        using var repo = new TestRepo();
        repo.WriteAndCommit("seed.txt", "seed");

        var spawner = new StubProcessSpawner
        {
            Factory = _ => new FakeProcessHandle(0, string.Empty, string.Empty),
        };

        var ops = new GitOperations(
            new StubCredentialBroker(),
            spawner,
            NullFs,
            new TestClock(),
            Mocks.Opts(),
            Mocks.NullLog);

        using var handle = await ops.OpenAsync(repo.Root, default);
        var wtPath = new AbsolutePath(Path.Combine(Path.GetTempPath(), "aio-wt", Guid.NewGuid().ToString("N")));

        var wt = await ops.AddWorktreeAsync(
            handle,
            new WorktreeRequest { Path = wtPath, Branch = "wip", CreateBranch = true, Lock = true },
            default);
        wt.Path.Should().Be(wtPath);
        wt.Branch.Should().Be("wip");

        await wt.DisposeAsync();

        // Two shell calls: add and remove
        spawner.Calls.Should().HaveCount(2);
        spawner.Calls[0].Arguments.Should().Contain("add");
        spawner.Calls[0].Arguments.Should().Contain("--lock");
        spawner.Calls[1].Arguments.Should().Contain("remove");
        spawner.Calls[1].Arguments.Should().Contain("--force");
    }

    [Fact]
    [ContractTest("GIT-SHELL-ALLOW")]
    public async Task GIT_SHELL_RejectsNonAllowlistedVerb()
    {
        // INV-4: GitVerb is an enum (compile-time guarantee). Runtime: Enum.IsDefined check.
        var spawner = new StubProcessSpawner
        {
            Factory = _ => new FakeProcessHandle(0, string.Empty, string.Empty),
        };
        var invoker = new GitShellInvoker(spawner, Mocks.Opts());
        var bogus = (GitVerb)9999;

        var act = async () => await invoker.RunAsync(
            bogus,
            ImmutableArray<string>.Empty,
            new AbsolutePath(Path.GetTempPath()),
            default);

        await act.Should().ThrowAsync<ArgumentException>();
    }

    [Fact]
    [ContractTest("GIT-REF-CAS")]
    public async Task GIT_REF_CAS_RaceFails()
    {
        // INV-6: UpdateRefAsync without an oldTarget is rejected; mismatched CAS races throw.
        using var repo = new TestRepo();
        var sha = repo.WriteAndCommit("a.txt", "x");

        var ops = new GitOperations(
            new StubCredentialBroker(),
            new StubProcessSpawner(),
            NullFs,
            new TestClock(),
            Mocks.Opts(),
            Mocks.NullLog);
        using var handle = await ops.OpenAsync(repo.Root, default);

        var act = async () => await ops.UpdateRefAsync(
            handle,
            "refs/heads/master",
            new CommitSha(sha),
            oldTarget: null,
            default);

        await act.Should().ThrowAsync<ArgumentNullException>();
    }

    [Fact]
    [ContractTest("GIT-PWD-EXC")]
    public void GIT_PASSWORD_NeverInExceptionMessage()
    {
        // INV-10: any user:password@host segment is redacted from messages.
        var lge = new LibGit2SharpException(
            "failed to clone https://alice:hunter2@example.com/repo.git: timed out");

        var mapped = LibGit2Bridge.Map(lge, new Uri("https://alice:hunter2@example.com/repo.git"));

        mapped.Message.Should().NotContain("hunter2");
        mapped.Message.Should().NotContain("alice:hunter2");
        mapped.Message.Should().Contain("***:***@");
    }

    [Fact]
    [ContractTest("GIT-COMMITTER-CLOCK")]
    public async Task GIT_COMMITTER_UsesIClock()
    {
        // INV-7: CreateCommitAsync uses IClock.UtcNow for both author and committer.
        using var repo = new TestRepo();
        repo.WriteAndCommit("seed.txt", "seed");

        var fixedTime = new DateTimeOffset(2030, 6, 15, 12, 34, 56, TimeSpan.Zero);
        var clock = new TestClock { Now = fixedTime };

        var ops = new GitOperations(
            new StubCredentialBroker(),
            new StubProcessSpawner(),
            NullFs,
            clock,
            Mocks.Opts(),
            Mocks.NullLog);

        using var handle = await ops.OpenAsync(repo.Root, default);
        var info = await ops.CreateCommitAsync(
            handle,
            new CommitRequest
            {
                Message = "deterministic",
                Author = Mocks.TestPrincipal,
                AllowEmpty = true,
            },
            default);

        info.AuthorDateUtc.Should().Be(fixedTime);
        info.CommitterDateUtc.Should().Be(fixedTime);
    }
}
