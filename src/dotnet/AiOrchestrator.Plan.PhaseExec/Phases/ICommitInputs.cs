// <copyright file="ICommitInputs.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Plan.PhaseExec.Phases;

/// <summary>
/// Provides the per-job inputs the <see cref="CommitPhase"/> needs to perform a commit.
/// Wired by the hosting layer (job 32) from the job's <c>WorkSpec</c>.
/// </summary>
public interface ICommitInputs
{
    /// <summary>Resolves the inputs for the given run.</summary>
    /// <param name="ctx">The phase context.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The materialized commit inputs.</returns>
    ValueTask<CommitInputs> GetAsync(PhaseRunContext ctx, CancellationToken ct);
}
