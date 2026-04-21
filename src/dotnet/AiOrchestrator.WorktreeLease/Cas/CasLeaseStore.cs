// <copyright file="CasLeaseStore.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

#pragma warning disable CA1303 // Do not pass literals as localized parameters — technical error text.

using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.WorktreeLease.Exceptions;

namespace AiOrchestrator.WorktreeLease.Cas;

/// <summary>
/// Implements compare-and-swap on the lease file <c>&lt;worktree&gt;/.aio/lease.json</c>
/// using <see cref="FileShare.None"/> for exclusive locking (LS-CAS-1, LS-INF-1).
/// </summary>
/// <remarks>
/// This class is the sole consumer of <see cref="FileStream"/> with <see cref="FileShare.None"/>
/// in this project. <see cref="IFileSystem"/> does not expose open-or-create with exclusive
/// share semantics, so the lower-level API is used here.
/// </remarks>
internal sealed class CasLeaseStore
{
    /// <summary>The current supported lease schema version.</summary>
    public const string SupportedSchemaVersion = "1";

    private const int DefaultBufferSize = 4096;

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = false,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly IFileSystem fs;
    private readonly IClock clock;

    public CasLeaseStore(IFileSystem fs, IClock clock)
    {
        this.fs = fs ?? throw new ArgumentNullException(nameof(fs));
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
    }

    /// <summary>Gets the clock used for timestamps; exposed for callers.</summary>
    public IClock Clock => this.clock;

    /// <summary>
    /// Attempts to atomically compare-and-swap the lease file.
    /// Opens <paramref name="leaseFile"/> with <see cref="FileShare.None"/>; reads the current
    /// token; if it matches <paramref name="expectedPriorToken"/>, writes <paramref name="content"/>
    /// and returns <see langword="true"/>. Otherwise returns <see langword="false"/>.
    /// </summary>
    /// <param name="leaseFile">Path to the lease file.</param>
    /// <param name="content">Content to write if the CAS succeeds.</param>
    /// <param name="expectedPriorToken">The token the caller believes is currently stored. Use <c>FencingToken(0)</c> when the file should not exist.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns><see langword="true"/> if the CAS succeeded and the file was written; otherwise <see langword="false"/>.</returns>
    /// <exception cref="UnsupportedLeaseSchemaException">Stored file uses an unknown schema version.</exception>
    public async ValueTask<bool> TryWriteAsync(
        AbsolutePath leaseFile,
        LeaseFileContent content,
        FencingToken expectedPriorToken,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(content);
        ct.ThrowIfCancellationRequested();

        EnsureParentDirectory(leaseFile);

        // Exclusive lock: FileShare.None. FileMode.OpenOrCreate so first-acquire path works.
        await using var stream = new FileStream(
            leaseFile.Value,
            FileMode.OpenOrCreate,
            FileAccess.ReadWrite,
            FileShare.None,
            DefaultBufferSize,
            useAsync: true);

        // If the file is non-empty, parse its current token.
        FencingToken currentToken = new(0);
        if (stream.Length > 0)
        {
            var existing = await ReadContentAsync(stream, ct).ConfigureAwait(false);
            currentToken = existing.Token;
        }

        if (currentToken.Value != expectedPriorToken.Value)
        {
            return false;
        }

        // CAS matched — truncate and overwrite.
        stream.Position = 0;
        stream.SetLength(0);
        await WriteContentAsync(stream, content, ct).ConfigureAwait(false);
        await stream.FlushAsync(ct).ConfigureAwait(false);
        return true;
    }

    /// <summary>Reads the current lease file, or <see langword="null"/> if none exists.</summary>
    /// <param name="leaseFile">Path to the lease file.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The parsed content, or <see langword="null"/> when the file is absent or empty.</returns>
    public async ValueTask<LeaseFileContent?> ReadAsync(AbsolutePath leaseFile, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (!File.Exists(leaseFile.Value))
        {
            return null;
        }

        // INV-10: read-only inspect uses FileShare.Read.
        await using var stream = new FileStream(
            leaseFile.Value,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            DefaultBufferSize,
            useAsync: true);

        if (stream.Length == 0)
        {
            return null;
        }

        return await ReadContentAsync(stream, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// LS-INF-1: Writes <paramref name="contents"/> to <paramref name="relativeFile"/> inside
    /// <paramref name="worktree"/> only if the on-disk lease token equals <paramref name="token"/>.
    /// Throws <see cref="StaleLeaseTokenException"/> and does NOT perform the write when stale.
    /// </summary>
    /// <param name="worktree">Absolute path to the worktree root.</param>
    /// <param name="token">The fencing token the caller believes it currently holds.</param>
    /// <param name="relativeFile">The repository-relative destination path.</param>
    /// <param name="contents">The bytes to write.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns><see langword="true"/> if the enforced write succeeded.</returns>
    /// <exception cref="StaleLeaseTokenException">The caller's token is older than the stored token.</exception>
    public async ValueTask<bool> EnforceWriteWithTokenAsync(
        AbsolutePath worktree,
        FencingToken token,
        RepoRelativePath relativeFile,
        ReadOnlyMemory<byte> contents,
        CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        var leaseFile = new AbsolutePath(Path.Combine(worktree.Value, ".aio", "lease.json"));
        var stored = await this.ReadAsync(leaseFile, ct).ConfigureAwait(false)
            ?? throw new StaleLeaseTokenException
            {
                ProvidedToken = token,
                StoredToken = new FencingToken(0),
            };

        if (stored.Token.Value != token.Value)
        {
            throw new StaleLeaseTokenException
            {
                ProvidedToken = token,
                StoredToken = stored.Token,
            };
        }

        var target = new AbsolutePath(Path.Combine(worktree.Value, relativeFile.Value));
        var parent = Path.GetDirectoryName(target.Value);
        if (!string.IsNullOrEmpty(parent))
        {
            _ = Directory.CreateDirectory(parent);
        }

        await using var writeStream = new FileStream(
            target.Value,
            FileMode.Create,
            FileAccess.Write,
            FileShare.None,
            DefaultBufferSize,
            useAsync: true);
        await writeStream.WriteAsync(contents, ct).ConfigureAwait(false);
        await writeStream.FlushAsync(ct).ConfigureAwait(false);
        return true;
    }

    /// <summary>Deletes the lease file for a worktree, if it exists. Retries briefly on transient sharing violations.</summary>
    /// <param name="leaseFile">Path to the lease file.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A completed <see cref="ValueTask"/>.</returns>
    public async ValueTask DeleteAsync(AbsolutePath leaseFile, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (!File.Exists(leaseFile.Value))
        {
            return;
        }

        // Under contention (e.g. another acquirer is probing with FileShare.None) a plain
        // File.Delete can fail with a sharing violation. Retry a few times with a short
        // back-off before giving up. The total budget here (~50 ms) is well under typical
        // acquire-retry intervals, so we never block the caller meaningfully.
        const int MaxAttempts = 10;
        for (var i = 0; i < MaxAttempts; i++)
        {
            try
            {
                File.Delete(leaseFile.Value);
                return;
            }
            catch (IOException) when (i < MaxAttempts - 1)
            {
                await Task.Delay(5, ct).ConfigureAwait(false);
            }
            catch (UnauthorizedAccessException) when (i < MaxAttempts - 1)
            {
                await Task.Delay(5, ct).ConfigureAwait(false);
            }
        }
    }

    internal static AbsolutePath LeaseFileFor(AbsolutePath worktree) =>
        new(Path.Combine(worktree.Value, ".aio", "lease.json"));

    private static void EnsureParentDirectory(AbsolutePath leaseFile)
    {
        var parent = Path.GetDirectoryName(leaseFile.Value);
        if (!string.IsNullOrEmpty(parent))
        {
            _ = Directory.CreateDirectory(parent);
        }
    }

    private static async ValueTask<LeaseFileContent> ReadContentAsync(FileStream stream, CancellationToken ct)
    {
        stream.Position = 0;
        using var ms = new MemoryStream();
        await stream.CopyToAsync(ms, ct).ConfigureAwait(false);
        var json = Encoding.UTF8.GetString(ms.ToArray());
        var dto = JsonSerializer.Deserialize<LeaseFileDto>(json, JsonOpts)
            ?? throw new InvalidDataException("Lease file is empty or invalid JSON.");

        if (!string.Equals(dto.SchemaVersion, SupportedSchemaVersion, StringComparison.Ordinal))
        {
            throw new UnsupportedLeaseSchemaException(dto.SchemaVersion ?? "<missing>");
        }

        return new LeaseFileContent
        {
            Token = new FencingToken(dto.Token),
            HolderUserName = dto.HolderUserName ?? string.Empty,
            HolderProcessHash = dto.HolderProcessHash ?? string.Empty,
            AcquiredAt = dto.AcquiredAt,
            ExpiresAt = dto.ExpiresAt,
            SchemaVersion = dto.SchemaVersion!,
        };
    }

    private static async ValueTask WriteContentAsync(FileStream stream, LeaseFileContent content, CancellationToken ct)
    {
        var dto = new LeaseFileDto
        {
            Token = content.Token.Value,
            HolderUserName = content.HolderUserName,
            HolderProcessHash = content.HolderProcessHash,
            AcquiredAt = content.AcquiredAt,
            ExpiresAt = content.ExpiresAt,
            SchemaVersion = content.SchemaVersion,
        };

        var json = JsonSerializer.Serialize(dto, JsonOpts);
        var bytes = Encoding.UTF8.GetBytes(json);
        await stream.WriteAsync(bytes.AsMemory(), ct).ConfigureAwait(false);
    }

    /// <summary>Data-transfer object used for JSON (camelCase) (de)serialization.</summary>
    private sealed class LeaseFileDto
    {
        public long Token { get; set; }

        public string? HolderUserName { get; set; }

        public string? HolderProcessHash { get; set; }

        public DateTimeOffset AcquiredAt { get; set; }

        public DateTimeOffset ExpiresAt { get; set; }

        public string? SchemaVersion { get; set; }
    }
}
