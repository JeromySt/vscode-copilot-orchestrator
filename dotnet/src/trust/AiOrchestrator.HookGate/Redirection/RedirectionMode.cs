// <copyright file="RedirectionMode.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.HookGate.Redirection;

/// <summary>
/// Mechanism currently installed to redirect the worktree's <c>.git/hooks</c> directory
/// to the canonical dispatcher path (HK-GATE-LINK-1 v1.4).
/// </summary>
public enum RedirectionMode
{
    /// <summary>No redirection installed.</summary>
    NotInstalled,

    /// <summary>Linux/macOS bind-mount (PRIMARY on POSIX).</summary>
    BindMount,

    /// <summary>Windows NTFS directory junction (PRIMARY on Windows).</summary>
    Junction,

    /// <summary>Plain symlink (FALLBACK only; emits immutability-unsupported).</summary>
    Symlink,
}
