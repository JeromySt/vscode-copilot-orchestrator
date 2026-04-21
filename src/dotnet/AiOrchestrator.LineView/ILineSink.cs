// <copyright file="ILineSink.cs" company="AiOrchestrator">
// Copyright (c) AiOrchestrator. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.LineView;

/// <summary>Receives complete lines emitted by <see cref="LineProjector"/>.</summary>
public interface ILineSink
{
    /// <summary>Invoked once per complete line. <paramref name="line"/> excludes the terminating LF/CRLF.</summary>
    /// <param name="line">The line bytes (UTF-8). Lifetime: only valid for the duration of the call.</param>
    void OnLine(ReadOnlySpan<byte> line);
}
