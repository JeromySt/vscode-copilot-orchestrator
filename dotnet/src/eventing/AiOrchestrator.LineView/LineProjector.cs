// <copyright file="LineProjector.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Buffers;
using System.IO.Pipelines;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.LineView;

/// <summary>
/// Incremental ANSI/UTF-8 line projector with a zero-allocation hot path.
/// Buffers carryover for partial UTF-8 sequences and incomplete lines across <see cref="Project"/> calls.
/// </summary>
public sealed class LineProjector
{
    private const byte Lf = (byte)'\n';
    private const byte Cr = (byte)'\r';
    private const byte Esc = 0x1B;
    private const byte BracketOpen = (byte)'[';

    private readonly LineProjectionOptions options;
    private byte[] carryover = new byte[256];
    private int carryoverLen;

    /// <summary>Initializes a new instance of the <see cref="LineProjector"/> class with default options.</summary>
    public LineProjector()
        : this(default)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="LineProjector"/> class.</summary>
    /// <param name="options">Projection options.</param>
    public LineProjector(LineProjectionOptions options)
    {
        this.options = options;
    }

    /// <summary>Project a chunk of bytes, emitting complete lines to <paramref name="sink"/>.</summary>
    /// <param name="chunk">The byte chunk to feed.</param>
    /// <param name="sink">The line sink.</param>
    /// <returns>Projection result.</returns>
    public LineProjectionResult Project(ReadOnlySpan<byte> chunk, ILineSink sink)
    {
        int linesEmitted = 0;
        int start = 0;

        for (int i = 0; i < chunk.Length; i++)
        {
            if (chunk[i] != Lf)
            {
                continue;
            }

            var segment = chunk.Slice(start, i - start);

            if (this.carryoverLen > 0)
            {
                this.EnsureCarryoverCapacity(this.carryoverLen + segment.Length);
                segment.CopyTo(this.carryover.AsSpan(this.carryoverLen));
                int totalLen = this.carryoverLen + segment.Length;

                if (totalLen > 0 && this.carryover[totalLen - 1] == Cr)
                {
                    totalLen--;
                }

                this.EmitLine(this.carryover.AsSpan(0, totalLen), sink);
                this.carryoverLen = 0;
            }
            else
            {
                int segLen = segment.Length;
                if (segLen > 0 && segment[segLen - 1] == Cr)
                {
                    segLen--;
                }

                this.EmitLine(segment.Slice(0, segLen), sink);
            }

            linesEmitted++;
            start = i + 1;
        }

        if (start < chunk.Length)
        {
            var remaining = chunk.Slice(start);
            this.EnsureCarryoverCapacity(this.carryoverLen + remaining.Length);
            remaining.CopyTo(this.carryover.AsSpan(this.carryoverLen));
            this.carryoverLen += remaining.Length;
        }

        return new LineProjectionResult { LinesEmitted = linesEmitted, BytesPending = this.carryoverLen };
    }

    /// <summary>Flush any buffered partial line as a final emission.</summary>
    /// <param name="sink">The line sink.</param>
    /// <returns>Projection result.</returns>
    public LineProjectionResult Flush(ILineSink sink)
    {
        if (this.carryoverLen == 0)
        {
            return default;
        }

        this.EmitLine(this.carryover.AsSpan(0, this.carryoverLen), sink);
        this.carryoverLen = 0;
        return new LineProjectionResult { LinesEmitted = 1 };
    }

    /// <summary>Asynchronously project lines from a <see cref="PipeReader"/>.</summary>
    /// <param name="reader">Source pipe reader.</param>
    /// <param name="sink">The line sink.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Aggregate projection result.</returns>
    public async ValueTask<LineProjectionResult> ProjectAsync(PipeReader reader, ILineSink sink, CancellationToken cancellationToken = default)
    {
        int totalLines = 0;

        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ReadResult readResult = await reader.ReadAsync(cancellationToken).ConfigureAwait(false);
            ReadOnlySequence<byte> buffer = readResult.Buffer;

            foreach (ReadOnlyMemory<byte> segment in buffer)
            {
                LineProjectionResult result = this.Project(segment.Span, sink);
                totalLines += result.LinesEmitted;
            }

            reader.AdvanceTo(buffer.End);

            if (readResult.IsCompleted)
            {
                break;
            }
        }

        LineProjectionResult flushResult = this.Flush(sink);
        totalLines += flushResult.LinesEmitted;

        return new LineProjectionResult { LinesEmitted = totalLines };
    }

    private void EmitLine(ReadOnlySpan<byte> line, ILineSink sink)
    {
        if (this.options.StripAnsi)
        {
            int maxLen = line.Length;
            byte[]? rented = maxLen > 1024 ? ArrayPool<byte>.Shared.Rent(maxLen) : null;
            Span<byte> stripped = rented is not null ? rented.AsSpan(0, maxLen) : stackalloc byte[maxLen];
            int j = 0;

            for (int i = 0; i < line.Length; i++)
            {
                if (line[i] == Esc && i + 1 < line.Length && line[i + 1] == BracketOpen)
                {
                    i += 2;
                    while (i < line.Length && !IsAnsiTerminator(line[i]))
                    {
                        i++;
                    }
                }
                else
                {
                    stripped[j++] = line[i];
                }
            }

            sink.OnLine(stripped.Slice(0, j));

            if (rented is not null)
            {
                ArrayPool<byte>.Shared.Return(rented);
            }
        }
        else
        {
            sink.OnLine(line);
        }
    }

    private static bool IsAnsiTerminator(byte b) =>
        (b >= (byte)'A' && b <= (byte)'Z') || (b >= (byte)'a' && b <= (byte)'z');

    private void EnsureCarryoverCapacity(int required)
    {
        if (this.carryover.Length >= required)
        {
            return;
        }

        int newLen = Math.Max(this.carryover.Length * 2, required);
        byte[] newBuf = new byte[newLen];
        this.carryover.AsSpan(0, this.carryoverLen).CopyTo(newBuf);
        this.carryover = newBuf;
    }
}
