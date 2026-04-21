// <copyright file="LineProjectionResult.cs" company="AiOrchestrator">
// Copyright (c) AiOrchestrator. All rights reserved.
// </copyright>

namespace AiOrchestrator.LineView;

/// <summary>Result of a single <see cref="LineProjector.Project"/> call.</summary>
public struct LineProjectionResult
{
    /// <summary>Gets or sets the number of complete lines emitted to the sink.</summary>
    public int LinesEmitted { get; set; }

    /// <summary>Gets or sets the number of bytes still buffered (incomplete line, partial UTF-8 sequence).</summary>
    public int BytesPending { get; set; }
}
