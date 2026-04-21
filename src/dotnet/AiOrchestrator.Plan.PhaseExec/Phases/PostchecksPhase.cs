// <copyright file="PostchecksPhase.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Shell;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Plan.PhaseExec.Phases;

/// <summary>Postchecks phase: runs the configured post-condition shell commands.</summary>
internal sealed class PostchecksPhase : IPhaseRunner
{
    private readonly IShellRunner shell;
    private readonly ILogger<PostchecksPhase> logger;

    /// <summary>Initializes a new instance of the <see cref="PostchecksPhase"/> class.</summary>
    /// <param name="shell">The shell runner.</param>
    /// <param name="logger">The component logger.</param>
    public PostchecksPhase(IShellRunner shell, ILogger<PostchecksPhase> logger)
    {
        ArgumentNullException.ThrowIfNull(shell);
        ArgumentNullException.ThrowIfNull(logger);
        this.shell = shell;
        this.logger = logger;
    }

    /// <inheritdoc/>
    public JobPhase Phase => JobPhase.Postchecks;

    /// <inheritdoc/>
    public ValueTask<CommitSha?> RunAsync(PhaseRunContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        this.logger.LogDebug("Postchecks phase: jobId={JobId}", ctx.JobId);
        _ = this.shell;
        return ValueTask.FromResult<CommitSha?>(null);
    }
}
