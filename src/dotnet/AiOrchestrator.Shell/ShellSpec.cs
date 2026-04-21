// <copyright file="ShellSpec.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Shell;

/// <summary>
/// Describes a unit of shell work to execute via <see cref="IShellRunner"/>.
/// The <see cref="Script"/> body is written to an isolated, owner-only temp file
/// (see <see cref="Temp.SecureTempScript"/>) and invoked through a hardened
/// command line (see <see cref="PowerShell.PowerShellCommandLineBuilder"/>).
/// </summary>
public sealed record ShellSpec
{
    /// <summary>Gets the shell interpreter to use.</summary>
    public required ShellKind Shell { get; init; }

    /// <summary>Gets the literal script body to execute (not a path).</summary>
    public required string Script { get; init; }

    /// <summary>Gets the absolute working directory in which to invoke the script.</summary>
    public required AbsolutePath WorkingDirectory { get; init; }

    /// <summary>Gets the environment variables exposed to the spawned shell process.</summary>
    public required ImmutableDictionary<string, string> Env { get; init; }

    /// <summary>Gets an optional run timeout. When <see langword="null"/> the runner uses <see cref="ShellOptions.DefaultTimeout"/>.</summary>
    public TimeSpan? Timeout { get; init; }

    /// <summary>
    /// Gets a value indicating whether stdout/stderr should be routed to the line-projector
    /// (job 15) for incremental UI display. Default is <see langword="true"/>.
    /// </summary>
    public bool CaptureStdoutToLineView { get; init; } = true;
}
