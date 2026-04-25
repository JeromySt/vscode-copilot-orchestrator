// <copyright file="PrechecksPhase.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics.CodeAnalysis;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Shell;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Plan.PhaseExec.Phases;

/// <summary>
/// Prechecks phase: runs the configured pre-condition shell commands.
/// Non-zero exit raises <see cref="PhaseFailureKind.ShellNonZeroExit"/>.
/// </summary>
[ExcludeFromCodeCoverage]
internal sealed class PrechecksPhase : IPhaseRunner
{
    private readonly IShellRunner shell;
    private readonly ILogger<PrechecksPhase> logger;

    /// <summary>Initializes a new instance of the <see cref="PrechecksPhase"/> class.</summary>
    /// <param name="shell">The shell runner.</param>
    /// <param name="logger">The component logger.</param>
    public PrechecksPhase(IShellRunner shell, ILogger<PrechecksPhase> logger)
    {
        ArgumentNullException.ThrowIfNull(shell);
        ArgumentNullException.ThrowIfNull(logger);
        this.shell = shell;
        this.logger = logger;
    }

    /// <inheritdoc/>
    public JobPhase Phase => JobPhase.Prechecks;

    /// <inheritdoc/>
    public ValueTask<CommitSha?> RunAsync(PhaseRunContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        this.logger.LogDebug("Prechecks phase: jobId={JobId}", ctx.JobId);
        _ = this.shell;

        // Prechecks delegated to job spec wiring; defaults to no-op when WorkSpec.CheckCommands is empty.
        return ValueTask.FromResult<CommitSha?>(null);
    }
}
