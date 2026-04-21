// <copyright file="ShellLineEmitted.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Shell.Eventing;

/// <summary>Identifies the stream a line was read from.</summary>
public enum ShellStream
{
    /// <summary>Standard output.</summary>
    Stdout,

    /// <summary>Standard error.</summary>
    Stderr,
}

/// <summary>
/// Published by <see cref="ShellRunner"/> for each complete line read from the
/// running process when <see cref="ShellSpec.CaptureStdoutToLineView"/> is
/// <see langword="true"/> (INV-8). Stand-in routing path until job 15
/// (<c>LineProjector</c>) lands a typed sink.
/// </summary>
public sealed record ShellLineEmitted
{
    /// <summary>Gets the job that produced the line.</summary>
    public required JobId JobId { get; init; }

    /// <summary>Gets the run that produced the line.</summary>
    public required RunId RunId { get; init; }

    /// <summary>Gets which stream (<c>stdout</c> or <c>stderr</c>) emitted the line.</summary>
    public required ShellStream Stream { get; init; }

    /// <summary>Gets the decoded UTF-8 text of the line, without trailing newline.</summary>
    public required string Line { get; init; }
}
