// <copyright file="ShellResult.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Git.Shell;

/// <summary>The textual stdout/stderr and exit code produced by a <see cref="GitShellInvoker"/> call.</summary>
/// <param name="ExitCode">The git process exit code.</param>
/// <param name="StandardOutput">Captured stdout, decoded as UTF-8.</param>
/// <param name="StandardError">Captured stderr, decoded as UTF-8.</param>
public sealed record ShellResult(int ExitCode, string StandardOutput, string StandardError);
