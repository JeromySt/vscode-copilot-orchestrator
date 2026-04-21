// <copyright file="HookCheckInRequest.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.HookGate;

/// <summary>A hook-process check-in presented to the daemon for approval (§3.8 v1.4).</summary>
public sealed record HookCheckInRequest
{
    /// <summary>Gets the kind of git hook being gated.</summary>
    public required HookKind Kind { get; init; }

    /// <summary>Gets the path to the hook file, relative to the worktree root.</summary>
    public required RepoRelativePath HookFile { get; init; }

    /// <summary>Gets the absolute path of the worktree root containing the hook.</summary>
    public required AbsolutePath WorktreeRoot { get; init; }

    /// <summary>Gets the principal invoking the hook.</summary>
    public required AuthContext Principal { get; init; }

    /// <summary>Gets the environment variables the hook expects (used in canonical-form HMAC).</summary>
    public required ImmutableDictionary<string, string> Env { get; init; }
}
