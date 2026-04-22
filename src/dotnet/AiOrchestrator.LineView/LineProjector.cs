// <copyright file="LineProjector.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
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
    private readonly LineProjectionOptions options;

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
        // TODO(LV-1..LV-6): implement zero-allocation incremental line splitting with carryover buffer.
        return default;
    }

    /// <summary>Flush any buffered partial line as a final emission.</summary>
    /// <param name="sink">The line sink.</param>
    /// <returns>Projection result.</returns>
    public LineProjectionResult Flush(ILineSink sink)
    {
        // TODO(LV-6): emit remaining buffered bytes if any.
        return default;
    }

    /// <summary>Asynchronously project lines from a <see cref="PipeReader"/>.</summary>
    /// <param name="reader">Source pipe reader.</param>
    /// <param name="sink">The line sink.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Aggregate projection result.</returns>
    public ValueTask<LineProjectionResult> ProjectAsync(PipeReader reader, ILineSink sink, CancellationToken cancellationToken = default)
    {
        // TODO(LV-ASYNC-1..2): implement async pump using PipeReader.
        return new ValueTask<LineProjectionResult>(default(LineProjectionResult));
    }
}
