// <copyright file="NullCommitInputs.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Plan.PhaseExec.Phases;

/// <summary>Default <see cref="ICommitInputs"/> when no other implementation is registered.</summary>
internal sealed class NullCommitInputs : ICommitInputs
{
    /// <inheritdoc/>
    public ValueTask<CommitInputs> GetAsync(PhaseRunContext ctx, CancellationToken ct) =>
        throw new System.InvalidOperationException(
            "No ICommitInputs implementation has been registered. The hosting layer must provide one.");
}
