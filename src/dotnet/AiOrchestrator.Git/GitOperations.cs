// <copyright file="GitOperations.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

#pragma warning disable RS0030 // LibGit2Sharp is intentionally permitted in this assembly.
#pragma warning disable CA1303 // localization not relevant for redacted technical messages

using System.Collections.Immutable;
using System.Runtime.CompilerServices;
using AiOrchestrator.Abstractions.Credentials;
using AiOrchestrator.Abstractions.Git;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Git.Bridge;
using AiOrchestrator.Git.Exceptions;
using AiOrchestrator.Git.Requests;
using AiOrchestrator.Git.Results;
using AiOrchestrator.Git.Shell;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;
using LibGit2Sharp;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Git;

/// <summary>
/// LibGit2Sharp-backed implementation of <see cref="IGitOperations"/> that also exposes
/// rich, request-shaped APIs (clone/fetch/merge/push/walk/diff/worktree/commit/ref-update).
/// All long-running operations honour cancellation via progress callbacks (LG2-CANCEL-*),
/// and every libgit2 exception is re-thrown as a typed <see cref="GitOperationException"/>
/// (LG2-BRK-*).
/// </summary>
public sealed class GitOperations : IGitOperations, IAsyncDisposable
{
    private readonly LibGit2Bridge bridge;
    private readonly GitShellInvoker shell;
    private readonly IFileSystem fs;
    private readonly IClock clock;
    private readonly IOptionsMonitor<GitOptions> opts;
    private readonly ILogger<GitOperations> logger;
    private bool disposed;

    /// <summary>Initializes a new instance of the <see cref="GitOperations"/> class.</summary>
    /// <param name="creds">Credential broker for remote operations.</param>
    /// <param name="spawner">Process spawner for shell-fallback verbs.</param>
    /// <param name="fs">File-system abstraction.</param>
    /// <param name="clock">Clock used for committer timestamps (INV-7).</param>
    /// <param name="opts">Options monitor.</param>
    /// <param name="logger">Logger.</param>
    public GitOperations(
        ICredentialBroker creds,
        IProcessSpawner spawner,
        IFileSystem fs,
        IClock clock,
        IOptionsMonitor<GitOptions> opts,
        ILogger<GitOperations> logger)
    {
        ArgumentNullException.ThrowIfNull(creds);
        ArgumentNullException.ThrowIfNull(spawner);
        this.bridge = new LibGit2Bridge(creds);
        this.shell = new GitShellInvoker(spawner, opts);
        this.fs = fs;
        this.clock = clock;
        this.opts = opts;
        this.logger = logger;
    }

    /// <summary>Opens a repository at the given path.</summary>
    /// <param name="path">Absolute path to the repo root.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>An owning handle to the repository.</returns>
    public ValueTask<Repository> OpenAsync(AbsolutePath path, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        try
        {
            var repo = new LibGit2Sharp.Repository(path.Value);
            return ValueTask.FromResult(new Repository(path, repo));
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            throw LibGit2Bridge.Map(ex);
        }
    }

    /// <summary>Performs a clone operation (LG2-CANCEL-1, LG2-BRK-*).</summary>
    /// <param name="request">The clone request.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A description of the cloned repository.</returns>
    public ValueTask<CloneResult> CloneAsync(CloneRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(request);
        ct.ThrowIfCancellationRequested();
        try
        {
            var options = new CloneOptions
            {
                IsBare = request.IsBare,
                BranchName = request.Branch,
            };
            options.FetchOptions.OnTransferProgress = LibGit2Bridge.CreateTransferCallback(ct);
            options.FetchOptions.CredentialsProvider = this.bridge.CreateCredentialProvider(request.Principal);
            options.OnCheckoutProgress = LibGit2Bridge.CreateCheckoutCallback(ct);

            var path = LibGit2Sharp.Repository.Clone(request.SourceUrl.ToString(), request.Destination.Value, options);
            using var repo = new LibGit2Sharp.Repository(path);
            var head = repo.Head.Tip ?? throw new InvalidOperationException("Cloned repository has no HEAD.");
            return ValueTask.FromResult(new CloneResult(request.Destination, LibGit2Bridge.FromObjectId(head.Id)));
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            throw LibGit2Bridge.Map(ex, request.SourceUrl);
        }
    }

    /// <summary>Performs a fetch operation.</summary>
    /// <param name="repo">The repository to fetch into.</param>
    /// <param name="request">The fetch request.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The fetch summary.</returns>
    public ValueTask<FetchResult> FetchAsync(Repository repo, FetchRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(repo);
        ArgumentNullException.ThrowIfNull(request);
        ct.ThrowIfCancellationRequested();
        try
        {
            var lg = repo.Underlying;
            var remote = lg.Network.Remotes[request.Remote]
                ?? throw new RefNotFoundException($"Remote '{request.Remote}' not found.") { RefName = request.Remote };

            var options = new FetchOptions
            {
                Prune = request.Prune,
                OnTransferProgress = LibGit2Bridge.CreateTransferCallback(ct),
                CredentialsProvider = this.bridge.CreateCredentialProvider(request.Principal),
            };

            var refspecs = request.RefSpecs.IsDefaultOrEmpty
                ? remote.FetchRefSpecs.Select(r => r.Specification).ToArray()
                : request.RefSpecs.ToArray();

            // LibGit2Sharp.Commands.Fetch requires the concrete Repository type.
            Commands.Fetch((LibGit2Sharp.Repository)lg, remote.Name, refspecs, options, logMessage: null);

            return ValueTask.FromResult(new FetchResult(0, 0));
        }
        catch (Exception ex) when (ex is not OperationCanceledException and not GitOperationException)
        {
            throw LibGit2Bridge.Map(ex);
        }
    }

    /// <summary>Performs a merge.</summary>
    /// <param name="repo">The repository.</param>
    /// <param name="request">The merge request.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The merge result.</returns>
    public ValueTask<Results.MergeResult> MergeAsync(Repository repo, MergeRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(repo);
        ArgumentNullException.ThrowIfNull(request);
        ct.ThrowIfCancellationRequested();
        try
        {
            var lg = repo.Underlying;
            var sig = this.MakeSignature(request.Principal);
            var commit = lg.Lookup<Commit>(LibGit2Bridge.ToObjectId(request.Source))
                ?? throw new RefNotFoundException($"Commit {request.Source.Hex} not found.") { RefName = request.Source.Hex };

            var options = new MergeOptions
            {
                FastForwardStrategy = request.NoFastForward ? FastForwardStrategy.NoFastForward : FastForwardStrategy.Default,
                OnCheckoutProgress = LibGit2Bridge.CreateCheckoutCallback(ct),
            };

            var result = lg.Merge(commit, sig, options);

            if (result.Status == MergeStatus.Conflicts)
            {
                var conflicts = ImmutableArray.CreateBuilder<RepoRelativePath>();
                foreach (var c in lg.Index.Conflicts)
                {
                    var p = c.Ours?.Path ?? c.Theirs?.Path ?? c.Ancestor?.Path;
                    if (p is not null)
                    {
                        conflicts.Add(new RepoRelativePath(p));
                    }
                }

                throw new MergeConflictException("Merge produced conflicts.")
                {
                    ConflictingPaths = conflicts.ToImmutable(),
                };
            }

            var head = lg.Head.Tip ?? throw new InvalidOperationException("HEAD missing after merge.");
            var outcome = result.Status switch
            {
                MergeStatus.UpToDate => MergeOutcome.UpToDate,
                MergeStatus.FastForward => MergeOutcome.FastForward,
                _ => MergeOutcome.NonFastForward,
            };
            return ValueTask.FromResult(new Results.MergeResult(outcome, LibGit2Bridge.FromObjectId(head.Id)));
        }
        catch (Exception ex) when (ex is not OperationCanceledException and not GitOperationException)
        {
            throw LibGit2Bridge.Map(ex);
        }
    }

    /// <summary>Performs a push.</summary>
    /// <param name="repo">The repository.</param>
    /// <param name="request">The push request.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The push result.</returns>
    public ValueTask<Results.PushResult> PushAsync(Repository repo, PushRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(repo);
        ArgumentNullException.ThrowIfNull(request);
        ct.ThrowIfCancellationRequested();
        Uri? remoteUrl = null;
        try
        {
            var lg = repo.Underlying;
            var remote = lg.Network.Remotes[request.Remote]
                ?? throw new RefNotFoundException($"Remote '{request.Remote}' not found.") { RefName = request.Remote };
            if (Uri.TryCreate(remote.Url, UriKind.Absolute, out var u))
            {
                remoteUrl = u;
            }

            var options = new PushOptions
            {
                CredentialsProvider = this.bridge.CreateCredentialProvider(request.Principal),
                OnPushTransferProgress = (_, _, _) => !ct.IsCancellationRequested,
            };

            lg.Network.Push(remote, request.RefSpecs.AsEnumerable(), options);
            return ValueTask.FromResult(new Results.PushResult(request.RefSpecs));
        }
        catch (Exception ex) when (ex is not OperationCanceledException and not GitOperationException)
        {
            throw LibGit2Bridge.Map(ex, remoteUrl);
        }
    }

    /// <summary>Adds a worktree using the shell allowlist (INV-5).</summary>
    /// <param name="repo">Main repository handle.</param>
    /// <param name="request">Worktree spec.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A handle whose disposal removes the worktree.</returns>
    public async ValueTask<WorktreeHandle> AddWorktreeAsync(Repository repo, WorktreeRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(repo);
        ArgumentNullException.ThrowIfNull(request);
        ct.ThrowIfCancellationRequested();

        var args = ImmutableArray.CreateBuilder<string>();
        args.Add("add");
        if (request.Lock)
        {
            args.Add("--lock");
        }

        if (request.CreateBranch)
        {
            args.Add("-b");
            args.Add(request.Branch);
            args.Add(request.Path.Value);
        }
        else
        {
            args.Add(request.Path.Value);
            args.Add(request.Branch);
        }

        var result = await this.shell.RunAsync(GitVerb.Worktree, args.ToImmutable(), repo.Path, ct).ConfigureAwait(false);
        if (result.ExitCode != 0)
        {
            throw new WorktreeLockedException($"git worktree add exited {result.ExitCode}: {result.StandardError}")
            {
                WorktreePath = request.Path,
                LockReason = result.StandardError,
            };
        }

        return new WorktreeHandle(this.shell, repo.Path, request.Path, request.Branch);
    }

    /// <summary>Removes a worktree (INV-5).</summary>
    /// <param name="handle">The handle.</param>
    /// <param name="force">When true, removes even if the worktree is dirty/locked.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A task that completes when removal is done.</returns>
    public ValueTask RemoveWorktreeAsync(WorktreeHandle handle, bool force, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(handle);
        _ = force;
        _ = ct;
        return handle.DisposeAsync();
    }

    /// <summary>Creates a commit using the configured <see cref="IClock"/> (INV-7).</summary>
    /// <param name="repo">The repository.</param>
    /// <param name="request">The commit request.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A descriptor of the new commit.</returns>
    public ValueTask<CommitInfo> CreateCommitAsync(Repository repo, CommitRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(repo);
        ArgumentNullException.ThrowIfNull(request);
        ct.ThrowIfCancellationRequested();
        try
        {
            var lg = repo.Underlying;
            var now = this.clock.UtcNow;
            var author = new Signature(request.Author.DisplayName, request.Author.PrincipalId, now);
            var committer = new Signature(
                (request.Committer ?? request.Author).DisplayName,
                (request.Committer ?? request.Author).PrincipalId,
                now);

            var commit = lg.Commit(request.Message, author, committer, new CommitOptions { AllowEmptyCommit = request.AllowEmpty });

            return ValueTask.FromResult(new CommitInfo(
                LibGit2Bridge.FromObjectId(commit.Id),
                commit.Message,
                author.Name,
                author.Email,
                author.When,
                committer.Name,
                committer.Email,
                committer.When));
        }
        catch (Exception ex) when (ex is not OperationCanceledException and not GitOperationException)
        {
            throw LibGit2Bridge.Map(ex);
        }
    }

    /// <summary>Performs an optimistic ref update (INV-6).</summary>
    /// <param name="repo">The repository.</param>
    /// <param name="refName">The qualified ref name.</param>
    /// <param name="newTarget">The desired new value.</param>
    /// <param name="oldTarget">The expected current value (CAS); must not be null.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The successful ref update.</returns>
    public ValueTask<RefUpdate> UpdateRefAsync(
        Repository repo,
        string refName,
        CommitSha newTarget,
        CommitSha? oldTarget,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(repo);
        ArgumentException.ThrowIfNullOrEmpty(refName);
        if (oldTarget is null)
        {
            throw new ArgumentNullException(nameof(oldTarget), "INV-6: ref updates must pass the expected old target for optimistic CAS.");
        }

        ct.ThrowIfCancellationRequested();
        try
        {
            var lg = repo.Underlying;
            var current = lg.Refs[refName] as DirectReference
                ?? throw new RefNotFoundException($"Ref '{refName}' not found or not a direct reference.") { RefName = refName };
            var actual = LibGit2Bridge.FromObjectId(current.Target.Id);
            if (!string.Equals(actual.Hex, oldTarget.Value.Hex, StringComparison.Ordinal))
            {
                throw new RefUpdateRaceException(
                    $"Ref '{refName}' expected {oldTarget.Value.Hex} but observed {actual.Hex}.")
                {
                    RefName = refName,
                    ExpectedOld = oldTarget.Value,
                    ActualOld = actual,
                };
            }

            _ = lg.Refs.UpdateTarget(current, LibGit2Bridge.ToObjectId(newTarget));
            return ValueTask.FromResult(new RefUpdate(refName, oldTarget.Value, newTarget));
        }
        catch (Exception ex) when (ex is not OperationCanceledException and not GitOperationException)
        {
            throw LibGit2Bridge.Map(ex);
        }
    }

    /// <summary>Walks history starting from <see cref="WalkRequest.From"/>.</summary>
    /// <param name="repo">The repository.</param>
    /// <param name="request">The walk request.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>An async stream of commits.</returns>
    public async IAsyncEnumerable<CommitInfo> WalkAsync(
        Repository repo,
        WalkRequest request,
        [EnumeratorCancellation] CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(repo);
        ArgumentNullException.ThrowIfNull(request);
        var lg = repo.Underlying;

        var filter = new CommitFilter
        {
            IncludeReachableFrom = LibGit2Bridge.ToObjectId(request.From),
            ExcludeReachableFrom = request.Until.HasValue ? LibGit2Bridge.ToObjectId(request.Until.Value) : null,
        };

        var count = 0;
        foreach (var c in lg.Commits.QueryBy(filter))
        {
            ct.ThrowIfCancellationRequested();
            yield return new CommitInfo(
                LibGit2Bridge.FromObjectId(c.Id),
                c.Message,
                c.Author.Name,
                c.Author.Email,
                c.Author.When,
                c.Committer.Name,
                c.Committer.Email,
                c.Committer.When);

            if (request.Limit is { } lim && ++count >= lim)
            {
                yield break;
            }

            await Task.Yield();
        }
    }

    /// <summary>Computes a diff between two trees.</summary>
    /// <param name="repo">The repository.</param>
    /// <param name="request">The diff request.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The diff result.</returns>
    public ValueTask<DiffResult> DiffAsync(Repository repo, DiffRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(repo);
        ArgumentNullException.ThrowIfNull(request);
        ct.ThrowIfCancellationRequested();
        try
        {
            var lg = repo.Underlying;
            var older = lg.Lookup<Commit>(LibGit2Bridge.ToObjectId(request.From))?.Tree
                ?? throw new RefNotFoundException($"Commit {request.From.Hex} not found.") { RefName = request.From.Hex };
            var newer = lg.Lookup<Commit>(LibGit2Bridge.ToObjectId(request.To))?.Tree
                ?? throw new RefNotFoundException($"Commit {request.To.Hex} not found.") { RefName = request.To.Hex };

            var diff = lg.Diff.Compare<TreeChanges>(older, newer);
            var entries = ImmutableArray.CreateBuilder<DiffEntry>();
            foreach (var change in diff)
            {
                var status = change.Status switch
                {
                    ChangeKind.Added => DiffStatus.Added,
                    ChangeKind.Deleted => DiffStatus.Deleted,
                    ChangeKind.Modified => DiffStatus.Modified,
                    ChangeKind.Renamed => DiffStatus.Renamed,
                    _ => DiffStatus.Modified,
                };
                entries.Add(new DiffEntry(
                    new RepoRelativePath(change.Path),
                    string.IsNullOrEmpty(change.OldPath) ? null : new RepoRelativePath(change.OldPath),
                    status));
            }

            return ValueTask.FromResult(new DiffResult(entries.ToImmutable()));
        }
        catch (Exception ex) when (ex is not OperationCanceledException and not GitOperationException)
        {
            throw LibGit2Bridge.Map(ex);
        }
    }

    // --- IGitOperations (compat surface backed by the rich APIs) -----------------------

    /// <inheritdoc/>
    public async ValueTask<GitStatus> StatusAsync(AbsolutePath repo, CancellationToken ct)
    {
        using var handle = await this.OpenAsync(repo, ct).ConfigureAwait(false);
        var lg = handle.Underlying;
        var status = lg.RetrieveStatus();
        var branch = lg.Head.FriendlyName;
        var ahead = lg.Head.TrackingDetails?.AheadBy ?? 0;
        var behind = lg.Head.TrackingDetails?.BehindBy ?? 0;
        return new GitStatus(branch, status.IsDirty, ahead, behind);
    }

    /// <inheritdoc/>
    public async ValueTask FetchAsync(AbsolutePath repo, string remote, CancellationToken ct)
    {
        using var handle = await this.OpenAsync(repo, ct).ConfigureAwait(false);
        var principal = AnonymousPrincipal();
        _ = await this.FetchAsync(handle, new FetchRequest { Remote = remote, Principal = principal }, ct).ConfigureAwait(false);
    }

    /// <inheritdoc/>
    public async ValueTask<CommitSha> CommitAsync(AbsolutePath repo, string message, AuthContext author, CancellationToken ct)
    {
        using var handle = await this.OpenAsync(repo, ct).ConfigureAwait(false);
        var info = await this.CreateCommitAsync(handle, new CommitRequest { Message = message, Author = author, AllowEmpty = false }, ct).ConfigureAwait(false);
        return info.Sha;
    }

    /// <inheritdoc/>
    public async ValueTask CreateWorktreeAsync(AbsolutePath repo, AbsolutePath worktreePath, string branch, CancellationToken ct)
    {
        using var handle = await this.OpenAsync(repo, ct).ConfigureAwait(false);
        var wt = await this.AddWorktreeAsync(handle, new WorktreeRequest { Path = worktreePath, Branch = branch }, ct).ConfigureAwait(false);

        // The simple-API caller does not track the handle; fire-and-forget the disposable here.
        _ = wt;
    }

    /// <inheritdoc/>
    public async ValueTask RemoveWorktreeAsync(AbsolutePath repo, AbsolutePath worktreePath, CancellationToken ct)
    {
        var args = new[] { "remove", "--force", worktreePath.Value }.ToImmutableArray();
        _ = await this.shell.RunAsync(GitVerb.Worktree, args, repo, ct).ConfigureAwait(false);
    }

    /// <inheritdoc/>
    public async ValueTask MergeAsync(AbsolutePath repo, string sourceBranch, CancellationToken ct)
    {
        using var handle = await this.OpenAsync(repo, ct).ConfigureAwait(false);
        var lg = handle.Underlying;
        var branch = lg.Branches[sourceBranch] ?? throw new RefNotFoundException($"Branch '{sourceBranch}' not found.") { RefName = sourceBranch };
        var tip = branch.Tip ?? throw new InvalidOperationException("Branch has no tip.");
        _ = await this.MergeAsync(handle, new MergeRequest { Source = LibGit2Bridge.FromObjectId(tip.Id), Principal = AnonymousPrincipal() }, ct).ConfigureAwait(false);
    }

    /// <inheritdoc/>
    public async ValueTask ResetHardAsync(AbsolutePath repo, CommitSha sha, CancellationToken ct)
    {
        using var handle = await this.OpenAsync(repo, ct).ConfigureAwait(false);
        var lg = handle.Underlying;
        try
        {
            var commit = lg.Lookup<Commit>(LibGit2Bridge.ToObjectId(sha)) ?? throw new RefNotFoundException($"Commit {sha.Hex} not found.") { RefName = sha.Hex };
            lg.Reset(ResetMode.Hard, commit);
        }
        catch (Exception ex) when (ex is not GitOperationException)
        {
            throw LibGit2Bridge.Map(ex);
        }
    }

    /// <inheritdoc/>
    public async ValueTask<CommitSha> GetHeadShaAsync(AbsolutePath repo, CancellationToken ct)
    {
        using var handle = await this.OpenAsync(repo, ct).ConfigureAwait(false);
        var head = handle.Underlying.Head.Tip ?? throw new InvalidOperationException("Repository has no HEAD commit.");
        return LibGit2Bridge.FromObjectId(head.Id);
    }

    /// <inheritdoc/>
    public ValueTask DisposeAsync()
    {
        if (this.disposed)
        {
            return ValueTask.CompletedTask;
        }

        this.disposed = true;
        this.logger.LogDebug("GitOperations disposed.");
        _ = this.fs;
        _ = this.opts;
        return ValueTask.CompletedTask;
    }

    private static AuthContext AnonymousPrincipal()
        => new()
        {
            PrincipalId = "anonymous@local",
            DisplayName = "anonymous",
            Scopes = ImmutableArray<string>.Empty,
        };

    private Signature MakeSignature(AuthContext principal)
        => new(principal.DisplayName, principal.PrincipalId, this.clock.UtcNow);
}

#pragma warning restore CA1303
#pragma warning restore RS0030
