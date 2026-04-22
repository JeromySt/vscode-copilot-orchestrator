// <copyright file="LibGit2Bridge.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Abstractions.Credentials;
using AiOrchestrator.Git.Exceptions;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;
using LibGit2Sharp;
using LibGit2Sharp.Handlers;

namespace AiOrchestrator.Git.Bridge;

/// <summary>
/// Thin wrapper around LibGit2Sharp that performs three concerns at the boundary:
/// <list type="bullet">
///   <item><description>cancellation propagation via progress callbacks (LG2-CANCEL-1, INV-1);</description></item>
///   <item><description>typed exception mapping (LG2-BRK-*, INV-3);</description></item>
///   <item><description>credential plumbing through <see cref="ICredentialBroker"/> (INV-8).</description></item>
/// </list>
/// </summary>
internal sealed class LibGit2Bridge
{
    private static readonly char[] PathSplitChars = new[] { '\r', '\n' };
    private readonly ICredentialBroker creds;

    /// <summary>Initializes a new instance of the <see cref="LibGit2Bridge"/> class.</summary>
    /// <param name="creds">Credential broker used for all remote authentication callbacks.</param>
    public LibGit2Bridge(ICredentialBroker creds)
    {
        this.creds = creds;
    }

    /// <summary>Maps a libgit2 exception (or a plain exception) to a typed <see cref="GitOperationException"/>.</summary>
    /// <param name="ex">The raw exception thrown by libgit2.</param>
    /// <param name="repoUrl">The remote URL involved, if applicable.</param>
    /// <returns>A typed exception describing the failure.</returns>
    public static GitOperationException Map(Exception ex, Uri? repoUrl = null)
    {
        ArgumentNullException.ThrowIfNull(ex);

        var redacted = Redact(ex.Message, repoUrl);
        switch (ex)
        {
            case CheckoutConflictException cce:
            {
                var paths = ImmutableArray.CreateBuilder<RepoRelativePath>();
                if (cce.Message is { } msg)
                {
                    foreach (var token in msg.Split(PathSplitChars, StringSplitOptions.RemoveEmptyEntries))
                    {
                        var trimmed = token.Trim();
                        if (LooksLikePath(trimmed))
                        {
                            paths.Add(new RepoRelativePath(trimmed));
                        }
                    }
                }

                return new MergeConflictException(redacted, ex)
                {
                    ConflictingPaths = paths.ToImmutable(),
                };
            }

            case MergeFetchHeadNotFoundException:
                return new RefNotFoundException(redacted, ex) { RefName = "FETCH_HEAD" };

            case NotFoundException nfe:
                return new RefNotFoundException(redacted, nfe) { RefName = ExtractRefName(nfe.Message) };

            case LockedFileException lfe:
                return new WorktreeLockedException(redacted, lfe)
                {
                    WorktreePath = new AbsolutePath("/locked"),
                    LockReason = redacted,
                };

            case LibGit2SharpException l2 when LooksLikeAuth(l2.Message):
                return new AuthFailureException(redacted, l2)
                {
                    RepoUrl = repoUrl ?? new Uri("about:blank"),
                };

            case LibGit2SharpException l2 when LooksLikeNetwork(l2.Message):
                return new NetworkErrorException(redacted, l2)
                {
                    RepoUrl = repoUrl ?? new Uri("about:blank"),
                    IsRetryable = true,
                };

            case LibGit2SharpException l2 when LooksLikeRemoteRejection(l2.Message):
                return new RemoteRejectedException(redacted, l2)
                {
                    Reason = redacted,
                    RemoteUrl = repoUrl?.ToString() ?? string.Empty,
                };

            case LibGit2SharpException l2:
                return new NetworkErrorException(redacted, l2)
                {
                    RepoUrl = repoUrl ?? new Uri("about:blank"),
                    IsRetryable = false,
                };

            default:
                return new NetworkErrorException(redacted, ex)
                {
                    RepoUrl = repoUrl ?? new Uri("about:blank"),
                    IsRetryable = false,
                };
        }
    }

    /// <summary>Returns true if any character in the cancellation token is set.</summary>
    /// <param name="ct">The token to test.</param>
    /// <returns><see langword="true"/> when cancelled.</returns>
    public static bool IsCancelled(CancellationToken ct) => ct.IsCancellationRequested;

    /// <summary>
    /// Builds a credential provider compatible with libgit2 that defers to the
    /// <see cref="ICredentialBroker"/> (INV-8). The returned secret is scrubbed by
    /// the credential's <see cref="IDisposable"/>.
    /// </summary>
    /// <param name="principal">The principal whose credentials should be requested.</param>
    /// <returns>A LG2-compatible credential provider.</returns>
    public CredentialsHandler CreateCredentialProvider(AuthContext principal)
    {
        return (url, _, _) =>
        {
            using var cred = this.creds.GetAsync(new Uri(url), principal, CancellationToken.None)
                .AsTask()
                .GetAwaiter()
                .GetResult();
            return new UsernamePasswordCredentials
            {
                Username = cred.Username,
                Password = cred.Password.Reveal(),
            };
        };
    }

    /// <summary>
    /// Builds a transfer-progress callback that returns <see langword="false"/> (i.e. abort)
    /// when the supplied cancellation token is set (INV-1, LG2-CANCEL-1).
    /// </summary>
    /// <param name="ct">The cancellation token to honour.</param>
    /// <returns>A LG2 transfer-progress callback.</returns>
    public static TransferProgressHandler CreateTransferCallback(CancellationToken ct)
        => _ => !ct.IsCancellationRequested;

    /// <summary>Builds a checkout progress callback that throws <see cref="OperationCanceledException"/> on cancellation.</summary>
    /// <param name="ct">The cancellation token to honour.</param>
    /// <returns>A LG2 checkout progress callback.</returns>
    public static CheckoutProgressHandler CreateCheckoutCallback(CancellationToken ct)
        => (_, _, _) => ct.ThrowIfCancellationRequested();

    /// <summary>Maps a <see cref="CommitSha"/> to a libgit2 ObjectId.</summary>
    /// <param name="sha">The SHA to convert.</param>
    /// <returns>The libgit2 object id.</returns>
    public static ObjectId ToObjectId(CommitSha sha) => new(sha.Hex);

    /// <summary>Maps a libgit2 ObjectId to a <see cref="CommitSha"/>.</summary>
    /// <param name="oid">The object id.</param>
    /// <returns>The SHA.</returns>
    public static CommitSha FromObjectId(ObjectId oid) => new(oid.Sha);

    private static string Redact(string? message, Uri? repoUrl)
    {
        if (string.IsNullOrEmpty(message))
        {
            return repoUrl is null ? "git operation failed" : $"git operation failed for {Sanitize(repoUrl)}";
        }

        // PII-safe: drop any "://user:password@" segments (INV-10).
        var redacted = System.Text.RegularExpressions.Regex.Replace(
            message,
            "(?<scheme>[a-z]+)://[^@/\\s]+:[^@/\\s]+@",
            "${scheme}://***:***@",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        return redacted;
    }

    private static Uri Sanitize(Uri u)
    {
        var b = new UriBuilder(u) { UserName = string.Empty, Password = string.Empty };
        return b.Uri;
    }

    private static bool LooksLikeAuth(string? message)
        => message is not null
            && (message.Contains("authentication", StringComparison.OrdinalIgnoreCase)
                || message.Contains("auth required", StringComparison.OrdinalIgnoreCase)
                || message.Contains("401", StringComparison.Ordinal)
                || message.Contains("403", StringComparison.Ordinal)
                || message.Contains("invalid credentials", StringComparison.OrdinalIgnoreCase));

    private static bool LooksLikeNetwork(string? message)
        => message is not null
            && (message.Contains("could not resolve host", StringComparison.OrdinalIgnoreCase)
                || message.Contains("connection", StringComparison.OrdinalIgnoreCase)
                || message.Contains("timed out", StringComparison.OrdinalIgnoreCase)
                || message.Contains("network", StringComparison.OrdinalIgnoreCase));

    private static bool LooksLikeRemoteRejection(string? message)
        => message is not null
            && (message.Contains("rejected", StringComparison.OrdinalIgnoreCase)
                || message.Contains("non-fast-forward", StringComparison.OrdinalIgnoreCase)
                || message.Contains("pre-receive hook", StringComparison.OrdinalIgnoreCase));

    private static bool LooksLikePath(string s)
        => !string.IsNullOrWhiteSpace(s)
            && !s.Contains(' ', StringComparison.Ordinal)
            && !s.StartsWith("error", StringComparison.OrdinalIgnoreCase);

    private static string ExtractRefName(string? message)
    {
        if (message is null)
        {
            return "<unknown>";
        }

        var idx = message.IndexOf("refs/", StringComparison.Ordinal);
        if (idx < 0)
        {
            return "<unknown>";
        }

        var end = message.IndexOfAny(new[] { ' ', '\'', '"' }, idx);
        return end < 0 ? message[idx..] : message[idx..end];
    }
}
