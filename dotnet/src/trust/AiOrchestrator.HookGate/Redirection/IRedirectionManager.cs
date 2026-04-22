// <copyright file="IRedirectionManager.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.HookGate.Redirection;

/// <summary>Installs, inspects, and removes the worktree hook-dir redirection (HK-GATE-LINK-1 v1.4).</summary>
public interface IRedirectionManager
{
    /// <summary>Installs a redirection from <paramref name="gitHooksDir"/> to <paramref name="canonicalDispatcherPath"/>.</summary>
    /// <param name="gitHooksDir">Absolute path to the worktree's <c>.git/hooks</c> directory.</param>
    /// <param name="canonicalDispatcherPath">Absolute path to the broker-owned dispatcher directory.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A task that completes when the redirection is in place.</returns>
    ValueTask InstallRedirectionAsync(AbsolutePath gitHooksDir, AbsolutePath canonicalDispatcherPath, CancellationToken ct);

    /// <summary>Removes any redirection previously installed on <paramref name="gitHooksDir"/>.</summary>
    /// <param name="gitHooksDir">Absolute path to the worktree's <c>.git/hooks</c> directory.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A task that completes when the redirection has been removed.</returns>
    ValueTask UninstallRedirectionAsync(AbsolutePath gitHooksDir, CancellationToken ct);

    /// <summary>Gets the currently-active redirection mode for <paramref name="gitHooksDir"/>.</summary>
    /// <param name="gitHooksDir">Absolute path to the worktree's <c>.git/hooks</c> directory.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The active <see cref="RedirectionMode"/>.</returns>
    ValueTask<RedirectionMode> GetActiveModeAsync(AbsolutePath gitHooksDir, CancellationToken ct);
}
