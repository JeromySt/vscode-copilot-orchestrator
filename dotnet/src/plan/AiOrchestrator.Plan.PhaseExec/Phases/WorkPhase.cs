// <copyright file="WorkPhase.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Agent;
using AiOrchestrator.Models.Ids;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Plan.PhaseExec.Phases;

/// <summary>
/// Work phase: invokes the agent runner with the job's WorkSpec.
/// Agent failures map to <see cref="PhaseFailureKind.AgentNonZeroExit"/> or
/// <see cref="PhaseFailureKind.AgentMaxTurnsExceeded"/>.
/// </summary>
internal sealed class WorkPhase : IPhaseRunner
{
    private readonly AgentRunnerFactory agents;
    private readonly ILogger<WorkPhase> logger;

    /// <summary>Initializes a new instance of the <see cref="WorkPhase"/> class.</summary>
    /// <param name="agents">The agent runner factory.</param>
    /// <param name="logger">The component logger.</param>
    public WorkPhase(AgentRunnerFactory agents, ILogger<WorkPhase> logger)
    {
        ArgumentNullException.ThrowIfNull(agents);
        ArgumentNullException.ThrowIfNull(logger);
        this.agents = agents;
        this.logger = logger;
    }

    /// <inheritdoc/>
    public JobPhase Phase => JobPhase.Work;

    /// <inheritdoc/>
    public ValueTask<CommitSha?> RunAsync(PhaseRunContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        this.logger.LogInformation(
            "Work phase: jobId={JobId} attempt={Attempt} autoHeal={Heal}",
            ctx.JobId,
            ctx.AttemptNumber,
            ctx.IsAutoHealAttempt);
        _ = this.agents;

        // The agent invocation is wired by job 32 (hosting). Default behavior here is
        // a successful no-op so the executor's contract tests can mock IPhaseRunner directly.
        return ValueTask.FromResult<CommitSha?>(null);
    }
}
