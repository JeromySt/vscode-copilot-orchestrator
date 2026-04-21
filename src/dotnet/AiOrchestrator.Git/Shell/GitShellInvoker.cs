// <copyright file="GitShellInvoker.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.IO.Pipelines;
using System.Text;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Models;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Git.Shell;

/// <summary>
/// Invokes the system <c>git</c> executable for the small set of operations LibGit2Sharp
/// cannot perform safely (worktree management, partial-clone filters, commit-graph,
/// sparse-checkout, fsmonitor handoff, maintenance). Every call is gated by the
/// <see cref="GitVerb"/> allowlist (INV-4).
/// </summary>
internal sealed class GitShellInvoker
{
    private readonly IProcessSpawner spawner;
    private readonly IOptionsMonitor<GitOptions> opts;

    /// <summary>Initializes a new instance of the <see cref="GitShellInvoker"/> class.</summary>
    /// <param name="spawner">Process spawner used to launch <c>git</c>.</param>
    /// <param name="opts">Git options (executable path, etc).</param>
    public GitShellInvoker(IProcessSpawner spawner, IOptionsMonitor<GitOptions> opts)
    {
        this.spawner = spawner;
        this.opts = opts;
    }

    /// <summary>Runs a single git verb with the supplied arguments.</summary>
    /// <param name="verb">The allowlisted verb.</param>
    /// <param name="args">Argument vector (not shell-parsed).</param>
    /// <param name="workingDir">Working directory to run the command in.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The captured stdout/stderr/exit code.</returns>
    public async ValueTask<ShellResult> RunAsync(
        GitVerb verb,
        ImmutableArray<string> args,
        AbsolutePath workingDir,
        CancellationToken ct)
    {
        // INV-4 runtime check: refuse any value not declared on the GitVerb enum.
        if (!Enum.IsDefined(verb))
        {
            throw new ArgumentException($"GitVerb '{verb}' is not in the allowlist.", nameof(verb));
        }

        var executable = this.opts.CurrentValue.GitExecutable?.Value ?? "git";

        var argv = ImmutableArray.CreateBuilder<string>();
        argv.Add("-C");
        argv.Add(workingDir.Value);
        argv.Add(VerbToString(verb));
        argv.AddRange(args);

        var spec = new ProcessSpec
        {
            Producer = "AiOrchestrator.Git",
            Description = $"git {VerbToString(verb)}",
            Executable = executable,
            Arguments = argv.ToImmutable(),
            Environment = null,
        };

        await using var handle = await this.spawner.SpawnAsync(spec, ct).ConfigureAwait(false);

        var stdoutTask = ReadAllAsync(handle.StandardOut, ct);
        var stderrTask = ReadAllAsync(handle.StandardError, ct);
        var exitCode = await handle.WaitForExitAsync(ct).ConfigureAwait(false);
        var stdout = await stdoutTask.ConfigureAwait(false);
        var stderr = await stderrTask.ConfigureAwait(false);

        return new ShellResult(exitCode, stdout, stderr);
    }

    private static string VerbToString(GitVerb verb) => verb switch
    {
        GitVerb.Worktree => "worktree",
        GitVerb.SparseCheckout => "sparse-checkout",
        GitVerb.CommitGraph => "commit-graph",
        GitVerb.FsMonitor => "fsmonitor--daemon",
        GitVerb.MaintenanceRun => "maintenance",
        _ => throw new ArgumentOutOfRangeException(nameof(verb), verb, null),
    };

    private static async Task<string> ReadAllAsync(PipeReader reader, CancellationToken ct)
    {
        var sb = new StringBuilder();
        while (true)
        {
            var read = await reader.ReadAsync(ct).ConfigureAwait(false);
            foreach (var segment in read.Buffer)
            {
                _ = sb.Append(Encoding.UTF8.GetString(segment.Span));
            }

            reader.AdvanceTo(read.Buffer.End);
            if (read.IsCompleted)
            {
                break;
            }
        }

        return sb.ToString();
    }
}
