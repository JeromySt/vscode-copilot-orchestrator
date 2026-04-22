// <copyright file="GitVerb.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Git.Shell;

/// <summary>
/// Allowlist of git verbs that the orchestrator is permitted to invoke through the
/// <see cref="GitShellInvoker"/>. The allowlist is enforced at compile time by the
/// enum type itself (INV-4), and again at runtime by <see cref="GitShellInvoker"/>.
/// </summary>
public enum GitVerb
{
    /// <summary>The <c>git worktree</c> family of subcommands.</summary>
    Worktree,

    /// <summary>The <c>git sparse-checkout</c> command.</summary>
    SparseCheckout,

    /// <summary>The <c>git commit-graph</c> command.</summary>
    CommitGraph,

    /// <summary>The <c>git fsmonitor--daemon</c> handoff.</summary>
    FsMonitor,

    /// <summary>The <c>git maintenance run</c> command.</summary>
    MaintenanceRun,
}
