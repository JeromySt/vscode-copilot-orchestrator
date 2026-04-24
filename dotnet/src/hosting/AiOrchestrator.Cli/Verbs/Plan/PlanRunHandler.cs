// <copyright file="PlanRunHandler.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.CommandLine;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Cli.Verbs.Plan;

/// <summary>
/// Handler for <c>aio plan run</c>. Blocks until the plan reaches a terminal state
/// and maps that terminal state onto a <see cref="CliExitCodes"/> value (INV-6).
/// </summary>
internal sealed class PlanRunHandler : VerbBase
{
    private readonly Option<string> planIdOption = new("--plan-id") { Required = true, Description = "Plan id." };
    private readonly Option<bool> detachOption = new("--detach") { Description = "Do not block; return immediately after submission." };

    public PlanRunHandler(IServiceProvider services)
        : base(services)
    {
    }

    /// <inheritdoc/>
    public override string VerbPath => "plan run";

    protected override string Description => "Run a plan and block until it terminates.";

    protected override IReadOnlyList<string> ExtraOptionHelp { get; } = new[]
    {
        "--plan-id <id>  Plan id (required).",
        "--detach        Return immediately without waiting for terminal state.",
    };

    protected override void ConfigureOptions(Command command)
    {
        command.Options.Add(this.planIdOption);
        command.Options.Add(this.detachOption);
    }

    protected override async Task<int> RunAsync(ParseResult result, CancellationToken ct)
    {
        string? planId = result.GetValue(this.planIdOption);
        if (string.IsNullOrWhiteSpace(planId))
        {
            await this.WriteVerbResultAsync(result, new VerbResult(this.VerbPath, false, "--plan-id is required", CliExitCodes.UsageError), ct).ConfigureAwait(false);
            return CliExitCodes.UsageError;
        }

        // Daemon integration is out of scope (job 34). Until the daemon is wired in,
        // `plan run` blocks by awaiting the cancellation token or the daemon probe,
        // returning DaemonUnavailable deterministically (INV-6 terminal state).
        var probe = (IDaemonProbe?)this.Services.GetService(typeof(IDaemonProbe));
        TerminalOutcome outcome = probe is null
            ? TerminalOutcome.DaemonUnavailable
            : await probe.WaitForTerminalAsync(planId, result.GetValue(this.detachOption), ct).ConfigureAwait(false);

        int exit = outcome switch
        {
            TerminalOutcome.Succeeded => CliExitCodes.Ok,
            TerminalOutcome.Partial => CliExitCodes.PlanPartial,
            TerminalOutcome.Canceled => CliExitCodes.PlanCanceled,
            TerminalOutcome.Failed => CliExitCodes.PlanFailed,
            _ => CliExitCodes.DaemonUnavailable,
        };

        await this.WriteVerbResultAsync(result, new VerbResult(this.VerbPath, outcome == TerminalOutcome.Succeeded, $"plan {planId} terminal={outcome}", exit), ct).ConfigureAwait(false);
        return exit;
    }
}

/// <summary>Abstract terminal outcomes returned by <see cref="IDaemonProbe"/>.</summary>
internal enum TerminalOutcome
{
    /// <summary>Plan completed successfully.</summary>
    Succeeded,

    /// <summary>Plan had a mix of succeeded and failed/canceled jobs.</summary>
    Partial,

    /// <summary>Plan was canceled.</summary>
    Canceled,

    /// <summary>Plan failed.</summary>
    Failed,

    /// <summary>The daemon was unreachable.</summary>
    DaemonUnavailable,
}

/// <summary>
/// Seam that lets tests inject a synchronous terminal-state result without
/// running a real daemon. Implementations may block.
/// </summary>
internal interface IDaemonProbe
{
    /// <summary>Waits for a plan to reach a terminal state.</summary>
    /// <param name="planId">The plan id.</param>
    /// <param name="detach">If <see langword="true"/>, return immediately with <see cref="TerminalOutcome.Succeeded"/>.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The terminal outcome.</returns>
    Task<TerminalOutcome> WaitForTerminalAsync(string planId, bool detach, CancellationToken ct);
}
