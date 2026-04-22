// <copyright file="ShellOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Shell;

/// <summary>Options controlling <see cref="ShellRunner"/> behavior.</summary>
public sealed record ShellOptions
{
    /// <summary>Gets the default per-run timeout when <see cref="ShellSpec.Timeout"/> is unset (INV-9).</summary>
    public TimeSpan DefaultTimeout { get; init; } = TimeSpan.FromMinutes(30);

    /// <summary>
    /// Gets the directory in which secure temp scripts are created. Must be on a
    /// volume the current user can write to with restricted ACLs (INV-6).
    /// </summary>
    public AbsolutePath TempDir { get; init; } = new AbsolutePath(System.IO.Path.GetTempPath());
}
