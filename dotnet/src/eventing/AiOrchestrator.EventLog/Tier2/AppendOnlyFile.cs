// <copyright file="AppendOnlyFile.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.EventLog.Tier2;

/// <summary>
/// Single-writer append-only T2 segment. Frames are written through <see cref="RecordFramer"/>
/// (length-prefix + monotonic recordSeq + payload + trailing CRC32C) and durably appended to a
/// shared file. A reader-friendly <see cref="FileShare.ReadWrite"/> handle is used so concurrent
/// readers may tail the file. Each <see cref="AppendAsync"/> call serialises through an internal
/// <see cref="SemaphoreSlim"/>; this is acceptable because it is not on the public publish hot path
/// (the no-locks invariant only governs <see cref="TieredEventLog.AppendAsync"/>'s caller-visible
/// branches, not the underlying disk-flush serialisation).
/// </summary>
internal sealed class AppendOnlyFile : IAsyncDisposable
{
    private readonly AbsolutePath path;
    private readonly FileStream stream;
    private readonly SemaphoreSlim writeGate = new(1, 1);
    private long currentLength;
    private int disposed;

    /// <summary>Initializes a new instance of the <see cref="AppendOnlyFile"/> class.</summary>
    /// <param name="path">The fully-qualified destination file. Created if it does not yet exist.</param>
    /// <param name="fs">File system abstraction for directory operations.</param>
    public AppendOnlyFile(AbsolutePath path, IFileSystem? fs = null)
    {
        this.path = path;
        var dir = System.IO.Path.GetDirectoryName(path.Value);
        if (!string.IsNullOrEmpty(dir))
        {
            if (fs is not null)
            {
                if (!fs.DirectoryExistsAsync(new AbsolutePath(dir), CancellationToken.None).AsTask().GetAwaiter().GetResult())
                {
                    fs.CreateDirectoryAsync(new AbsolutePath(dir), CancellationToken.None).AsTask().GetAwaiter().GetResult();
                }
            }
            else
            {
#pragma warning disable OE0004 // Fallback when IFileSystem is not provided (backward compat)
                if (!Directory.Exists(dir))
                {
                    _ = Directory.CreateDirectory(dir);
                }
#pragma warning restore OE0004
            }
        }

        this.stream = new FileStream(
            path.Value,
            FileMode.Append,
            FileAccess.Write,
            FileShare.ReadWrite,
            bufferSize: 4096,
            useAsync: true);
        this.currentLength = this.stream.Length;
    }

    /// <summary>Gets the path of the underlying segment file.</summary>
    public AbsolutePath Path => this.path;

    /// <summary>Gets the current on-disk length of the segment in bytes.</summary>
    public long Length => this.currentLength;

    /// <summary>Appends a previously-framed record to the segment.</summary>
    /// <param name="framedRecord">The framed bytes (header + payload + CRC) produced by <see cref="RecordFramer.Frame"/>.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A task that completes once the bytes have been flushed to disk.</returns>
    public async ValueTask AppendAsync(ReadOnlyMemory<byte> framedRecord, CancellationToken ct)
    {
        if (Volatile.Read(ref this.disposed) != 0)
        {
            throw new ObjectDisposedException(nameof(AppendOnlyFile));
        }

        await this.writeGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await this.stream.WriteAsync(framedRecord, ct).ConfigureAwait(false);
            await this.stream.FlushAsync(ct).ConfigureAwait(false);
            this.currentLength += framedRecord.Length;
        }
        finally
        {
            _ = this.writeGate.Release();
        }
    }

    /// <summary>Reads frames sequentially from the segment starting at <paramref name="startOffset"/>.</summary>
    /// <param name="startOffset">The byte offset to begin reading from.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>An async enumerable of decoded raw records.</returns>
    public async IAsyncEnumerable<RawRecord> ReadFromAsync(
        long startOffset,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        await using var read = new FileStream(
            this.path.Value,
            FileMode.OpenOrCreate,
            FileAccess.Read,
            FileShare.ReadWrite,
            bufferSize: 4096,
            useAsync: true);
        if (startOffset > 0)
        {
            _ = read.Seek(startOffset, SeekOrigin.Begin);
        }

        var buf = new byte[64 * 1024];
        var pending = new List<byte>(capacity: 1024);
        long lastSeq = 0;

        while (!ct.IsCancellationRequested)
        {
            var n = await read.ReadAsync(buf.AsMemory(), ct).ConfigureAwait(false);
            if (n <= 0)
            {
                break;
            }

            pending.AddRange(buf.AsSpan(0, n).ToArray());

            while (true)
            {
                if (pending.Count < RecordFramer.HeaderSize)
                {
                    break;
                }

                var snapshot = pending.ToArray();
                var seq = new System.Buffers.ReadOnlySequence<byte>(snapshot);
                if (!RecordFramer.TryUnframe(seq, lastSeq, out var rec, out var consumed, out var err))
                {
                    if (err == FrameError.IncompleteHeader || err == FrameError.IncompleteBody)
                    {
                        break;
                    }

                    // Tail-truncated or corrupted partial: stop reading from this segment.
                    yield break;
                }

                yield return rec;
                lastSeq = rec.RecordSeq;
                var consumedLen = (int)seq.Slice(seq.Start, consumed).Length;
                pending.RemoveRange(0, consumedLen);
            }
        }
    }

    /// <inheritdoc />
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref this.disposed, 1) != 0)
        {
            return;
        }

        try
        {
            await this.stream.FlushAsync().ConfigureAwait(false);
        }
        catch (ObjectDisposedException)
        {
            // best-effort
        }

        await this.stream.DisposeAsync().ConfigureAwait(false);
        this.writeGate.Dispose();
    }
}
