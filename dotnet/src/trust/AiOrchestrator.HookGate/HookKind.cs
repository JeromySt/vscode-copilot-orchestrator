// <copyright file="HookKind.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.HookGate;

/// <summary>The git hook being gated.</summary>
public enum HookKind
{
    /// <summary>pre-commit.</summary>
    PreCommit,

    /// <summary>commit-msg.</summary>
    CommitMsg,

    /// <summary>pre-push.</summary>
    PrePush,

    /// <summary>post-checkout.</summary>
    PostCheckout,

    /// <summary>pre-rebase.</summary>
    PreRebase,

    /// <summary>post-merge.</summary>
    PostMerge,

    /// <summary>pre-receive (server-side).</summary>
    PreReceive,

    /// <summary>update (server-side).</summary>
    Update,

    /// <summary>post-receive (server-side).</summary>
    PostReceive,

    /// <summary>post-update (server-side).</summary>
    PostUpdate,

    /// <summary>prepare-commit-msg.</summary>
    PrepareCommitMsg,
}
