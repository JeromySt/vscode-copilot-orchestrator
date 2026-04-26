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
    /// Gets the global daemon log directory.
    /// Windows: <c>%LOCALAPPDATA%/ai-orchestrator/logs/</c>.
    /// Linux/macOS: <c>~/.local/share/ai-orchestrator/logs/</c>.
    /// </summary>
    public static string GlobalDaemonLogDir
    {
        get
        {
            var root = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
                ? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)
                : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local", "share");
            return Path.Combine(root, "ai-orchestrator", "logs");
        }
    }

    /// <summary>
    /// Gets the global daemon log path for the current process:
    /// <c>{logDir}/aio-daemon-{pid}.log</c>.
    /// Each daemon instance writes to its own PID-scoped file so that
    /// multiple concurrent daemons (one per workspace) do not collide.
    /// </summary>
    public static string GlobalDaemonLog =>
        Path.Combine(GlobalDaemonLogDir, $"aio-daemon-{Environment.ProcessId}.log");

    /// <summary>
    /// Search pattern for finding all daemon log files in the global log directory.
    /// </summary>
    public static string GlobalDaemonLogPattern => "aio-daemon-*.log";

    /// <summary>
    /// Gets the per-repo daemon log path: <c>{repoRoot}/.aio/aio_logs/aio-daemon-{pid}.log</c>.
    /// </summary>
    /// <param name="repoRoot">The absolute path to the repository root.</param>
    /// <returns>The log file path scoped to this process and repository.</returns>
    public static string RepoLog(string repoRoot) =>
        Path.Combine(repoRoot, ".aio", "aio_logs", $"aio-daemon-{Environment.ProcessId}.log");
}
