// <copyright file="GitignoreManager.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Git.Gitignore;

/// <summary>
/// Manages .gitignore entries for orchestrator-generated runtime state.
/// Entries are written lazily (at plan start / worktree creation) and idempotently.
/// </summary>
public static class GitignoreManager
{
    /// <summary>The canonical set of patterns the orchestrator requires in .gitignore.</summary>
    public static readonly IReadOnlyList<string> OrchestratorEntries = new[]
    {
        ".aio/",
        ".worktrees/",
        ".orchestrator/",
        ".copilot-cli/",
        ".github/instructions/orchestrator-*.instructions.md",
    };

    /// <summary>The header comment used to mark orchestrator-managed entries.</summary>
    internal const string Header = "# Copilot Orchestrator — managed entries (do not remove)";

    /// <summary>
    /// Ensures the specified patterns exist in the .gitignore at the given repo root.
    /// Returns <c>true</c> if the file was modified, <c>false</c> if already up-to-date.
    /// </summary>
    public static async Task<bool> EnsureEntriesAsync(
        string repoRoot,
        IReadOnlyList<string>? entries = null,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(repoRoot);
        entries ??= OrchestratorEntries;
        var gitignorePath = Path.Combine(repoRoot, ".gitignore");

        // Read existing content
        var existingLines = new HashSet<string>(StringComparer.Ordinal);
        string existingContent = string.Empty;
        if (File.Exists(gitignorePath))
        {
            existingContent = await File.ReadAllTextAsync(gitignorePath, ct).ConfigureAwait(false);
            foreach (var line in existingContent.Split('\n'))
            {
                existingLines.Add(line.TrimEnd('\r'));
            }
        }

        // Find missing entries
        var missing = new List<string>();
        foreach (var entry in entries)
        {
            if (!existingLines.Contains(entry))
            {
                missing.Add(entry);
            }
        }

        if (missing.Count == 0)
        {
            return false; // Already up-to-date
        }

        // Append missing entries under our header
        var sb = new StringBuilder(existingContent);
        if (sb.Length > 0 && !existingContent.EndsWith('\n'))
        {
            sb.AppendLine();
        }

        // Only add header if it doesn't already exist
        if (!existingLines.Contains(Header))
        {
            sb.AppendLine();
            sb.AppendLine(Header);
        }

        foreach (var entry in missing)
        {
            sb.AppendLine(entry);
        }

        await File.WriteAllTextAsync(gitignorePath, sb.ToString(), ct).ConfigureAwait(false);
        return true;
    }

    /// <summary>
    /// Ensures the full set of orchestrator entries are in the .gitignore.
    /// Convenience wrapper for <see cref="EnsureEntriesAsync"/>.
    /// </summary>
    public static Task<bool> EnsureOrchestratorGitIgnoreAsync(
        string repoRoot, CancellationToken ct = default)
        => EnsureEntriesAsync(repoRoot, OrchestratorEntries, ct);

    /// <summary>
    /// Returns <c>true</c> if all orchestrator entries are already present in the .gitignore.
    /// </summary>
    public static async Task<bool> IsConfiguredAsync(
        string repoRoot, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(repoRoot);
        var gitignorePath = Path.Combine(repoRoot, ".gitignore");
        if (!File.Exists(gitignorePath))
        {
            return false;
        }

        var content = await File.ReadAllTextAsync(gitignorePath, ct).ConfigureAwait(false);
        var lines = new HashSet<string>(
            content.Split('\n').Select(l => l.TrimEnd('\r')),
            StringComparer.Ordinal);

        return OrchestratorEntries.All(lines.Contains);
    }

    /// <summary>
    /// Checks if a unified diff only contains changes to orchestrator-managed .gitignore lines.
    /// Used to auto-discard orchestrator-only diffs during reverse integration merges.
    /// </summary>
    public static bool IsDiffOnlyOrchestratorChanges(string unifiedDiff)
    {
        ArgumentNullException.ThrowIfNull(unifiedDiff);

        foreach (var line in unifiedDiff.Split('\n'))
        {
            var trimmed = line.TrimEnd('\r');

            // Skip diff headers
            if (trimmed.StartsWith("---", StringComparison.Ordinal) ||
                trimmed.StartsWith("+++", StringComparison.Ordinal) ||
                trimmed.StartsWith("@@", StringComparison.Ordinal) ||
                trimmed.StartsWith("diff ", StringComparison.Ordinal) ||
                trimmed.StartsWith("index ", StringComparison.Ordinal) ||
                string.IsNullOrWhiteSpace(trimmed))
            {
                continue;
            }

            // Added/removed lines must match orchestrator patterns or header
            if (trimmed.StartsWith('+') || trimmed.StartsWith('-'))
            {
                var content = trimmed[1..];
                if (string.IsNullOrWhiteSpace(content) ||
                    content == Header ||
                    OrchestratorEntries.Contains(content))
                {
                    continue;
                }

                return false; // Non-orchestrator change found
            }

            // Context lines are fine
        }

        return true;
    }
}
