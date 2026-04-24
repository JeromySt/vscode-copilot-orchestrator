// <copyright file="AioLogPaths.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;

namespace AiOrchestrator.Logging;

/// <summary>
/// Resolves log file paths for the orchestrator daemon.
/// </summary>
public static class AioLogPaths
{
    /// <summary>
    /// Gets the global daemon log path.
    /// Windows: <c>%LOCALAPPDATA%/ai-orchestrator/logs/aio-daemon.log</c>.
    /// Linux/macOS: <c>~/.local/share/ai-orchestrator/logs/aio-daemon.log</c>.
    /// </summary>
    public static string GlobalDaemonLog
    {
        get
        {
            var root = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
                ? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)
                : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local", "share");
            return Path.Combine(root, "ai-orchestrator", "logs", "aio-daemon.log");
        }
    }

    /// <summary>
    /// Gets the per-repo daemon log path: <c>{repoRoot}/.aio/aio_logs/aio-daemon-{pid}.log</c>.
    /// </summary>
    /// <param name="repoRoot">The absolute path to the repository root.</param>
    /// <returns>The log file path scoped to this process and repository.</returns>
    public static string RepoLog(string repoRoot) =>
        Path.Combine(repoRoot, ".aio", "aio_logs", $"aio-daemon-{Environment.ProcessId}.log");
}
