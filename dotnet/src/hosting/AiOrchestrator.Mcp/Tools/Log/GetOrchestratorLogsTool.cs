// <copyright file="GetOrchestratorLogsTool.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Logging;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Mcp.Tools.Log;

/// <summary>MCP tool: <c>get_orchestrator_logs</c> — Retrieve tail lines from daemon or per-repo log files.</summary>
internal sealed class GetOrchestratorLogsTool : IMcpTool
{
    private const int DefaultTailLines = 200;

    private static readonly JsonNode Schema = new JsonObject
    {
        ["type"] = "object",
        ["properties"] = new JsonObject
        {
            ["kind"] = new JsonObject
            {
                ["type"] = "string",
                ["enum"] = new JsonArray("daemon", "repo"),
                ["description"] = "Which log to read: 'daemon' for the global daemon log, 'repo' for the per-repository log.",
            },
            ["repo_root"] = new JsonObject
            {
                ["type"] = "string",
                ["description"] = "Absolute path to the repository root. Required when kind is 'repo'.",
            },
            ["tail_lines"] = new JsonObject
            {
                ["type"] = "integer",
                ["description"] = "Number of lines to return from the end of the log file.",
                ["default"] = DefaultTailLines,
            },
        },
        ["required"] = new JsonArray("kind"),
        ["additionalProperties"] = false,
    };

    private readonly IFileSystem fs;

    public GetOrchestratorLogsTool(IFileSystem fs)
    {
        this.fs = fs ?? throw new ArgumentNullException(nameof(fs));
    }

    /// <inheritdoc/>
    public string Name => "get_orchestrator_logs";

    /// <inheritdoc/>
    public string Description => "Retrieve the last N lines from the orchestrator daemon log or a per-repo log.";

    /// <inheritdoc/>
    public JsonNode InputSchema => Schema;

    /// <inheritdoc/>
    public async ValueTask<JsonNode> InvokeAsync(JsonElement parameters, CancellationToken ct)
    {
        string kind = parameters.GetProperty("kind").GetString()!;
        int tailLines = parameters.TryGetProperty("tail_lines", out JsonElement tlElem) && tlElem.ValueKind == JsonValueKind.Number
            ? tlElem.GetInt32()
            : DefaultTailLines;

        if (tailLines <= 0)
        {
            tailLines = DefaultTailLines;
        }

        return kind switch
        {
            "daemon" => await this.ReadDaemonLogAsync(tailLines, ct).ConfigureAwait(false),
            "repo" => await this.ReadRepoLogAsync(parameters, tailLines, ct).ConfigureAwait(false),
            _ => new JsonObject { ["success"] = false, ["error"] = $"Unknown kind: '{kind}'. Expected 'daemon' or 'repo'." },
        };
    }

    private async ValueTask<JsonNode> ReadDaemonLogAsync(int tailLines, CancellationToken ct)
    {
        var logDir = new AbsolutePath(AioLogPaths.GlobalDaemonLogDir);
        if (!await this.fs.DirectoryExistsAsync(logDir, ct).ConfigureAwait(false))
        {
            return new JsonObject { ["success"] = false, ["error"] = $"Log directory does not exist: {logDir}" };
        }

        // Each daemon instance writes to aio-daemon-{pid}.log.
        // Return the most recent (lexically highest = largest PID number).
        AbsolutePath? latestLog = null;
        await foreach (AbsolutePath file in this.fs.EnumerateFilesAsync(logDir, AioLogPaths.GlobalDaemonLogPattern, ct).ConfigureAwait(false))
        {
            if (latestLog is null || string.Compare(file.Value, latestLog.Value.Value, StringComparison.OrdinalIgnoreCase) > 0)
            {
                latestLog = file;
            }
        }

        if (latestLog is null)
        {
            return new JsonObject { ["success"] = false, ["error"] = $"No daemon log files found in {logDir}" };
        }

        return await this.ReadTailAsync(latestLog.Value, tailLines, ct).ConfigureAwait(false);
    }

    private async ValueTask<JsonNode> ReadRepoLogAsync(JsonElement parameters, int tailLines, CancellationToken ct)
    {
        if (!parameters.TryGetProperty("repo_root", out JsonElement repoElem) ||
            repoElem.ValueKind != JsonValueKind.String ||
            string.IsNullOrWhiteSpace(repoElem.GetString()))
        {
            return new JsonObject { ["success"] = false, ["error"] = "repo_root is required when kind is 'repo'." };
        }

        string repoRoot = repoElem.GetString()!;
        if (!Path.IsPathRooted(repoRoot))
        {
            return new JsonObject { ["success"] = false, ["error"] = "repo_root must be an absolute path." };
        }

        var logsDir = new AbsolutePath(Path.Combine(repoRoot, ".aio", "aio_logs"));
        if (!await this.fs.DirectoryExistsAsync(logsDir, ct).ConfigureAwait(false))
        {
            return new JsonObject { ["success"] = false, ["error"] = $"Log directory does not exist: {logsDir}" };
        }

        // Find the most recent aio-daemon-*.log file (highest PID ≈ most recent process).
        AbsolutePath? latestLog = null;
        await foreach (AbsolutePath file in this.fs.EnumerateFilesAsync(logsDir, "aio-daemon-*.log", ct).ConfigureAwait(false))
        {
            if (latestLog is null || string.Compare(file.Value, latestLog.Value.Value, StringComparison.OrdinalIgnoreCase) > 0)
            {
                latestLog = file;
            }
        }

        if (latestLog is null)
        {
            return new JsonObject { ["success"] = false, ["error"] = $"No log files found in {logsDir}" };
        }

        return await this.ReadTailAsync(latestLog.Value, tailLines, ct).ConfigureAwait(false);
    }

    private async ValueTask<JsonNode> ReadTailAsync(AbsolutePath path, int tailLines, CancellationToken ct)
    {
        if (!await this.fs.FileExistsAsync(path, ct).ConfigureAwait(false))
        {
            return new JsonObject { ["success"] = false, ["error"] = $"Log file not found: {path}" };
        }

        string content = await this.fs.ReadAllTextAsync(path, ct).ConfigureAwait(false);
        string[] allLines = content.Split('\n');

        string[] tail = allLines.Length <= tailLines
            ? allLines
            : allLines[^tailLines..];

        return new JsonObject
        {
            ["success"] = true,
            ["path"] = path.Value,
            ["total_lines"] = allLines.Length,
            ["returned_lines"] = tail.Length,
            ["content"] = string.Join("\n", tail),
        };
    }
}
