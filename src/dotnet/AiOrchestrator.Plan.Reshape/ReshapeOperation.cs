// <copyright file="ReshapeOperation.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Models;

namespace AiOrchestrator.Plan.Reshape;

/// <summary>Base record for every reshape operation per §3.12.4.</summary>
public abstract record ReshapeOperation
{
}

/// <summary>Adds a new job node with the given dependencies.</summary>
/// <param name="Spec">The full <see cref="JobNode"/> to insert.</param>
/// <param name="Dependencies">IDs of existing jobs the new job must wait on.</param>
public sealed record AddJob(JobNode Spec, ImmutableArray<JobId> Dependencies) : ReshapeOperation;

/// <summary>Removes an existing job node. Only permitted while the node is Pending or Ready (INV-6).</summary>
/// <param name="TargetJobId">The job to remove.</param>
public sealed record RemoveJob(JobId TargetJobId) : ReshapeOperation;

/// <summary>Replaces the dependency list of an existing job. Only permitted while the node is Pending (INV-7).</summary>
/// <param name="TargetJobId">The job whose dependencies are replaced.</param>
/// <param name="NewDependencies">The new dependency list.</param>
public sealed record UpdateDeps(JobId TargetJobId, ImmutableArray<JobId> NewDependencies) : ReshapeOperation;

/// <summary>
/// Inserts <paramref name="NewJobSpec"/> so that <paramref name="ExistingJobId"/> depends on the new job
/// (i.e. the new job runs BEFORE the existing one).
/// </summary>
/// <param name="ExistingJobId">The existing job that should gain a new upstream dependency.</param>
/// <param name="NewJobSpec">The new job to insert.</param>
/// <param name="NewJobDependencies">The new job's own dependencies (upstream of the new node).</param>
public sealed record AddBefore(JobId ExistingJobId, JobNode NewJobSpec, ImmutableArray<JobId> NewJobDependencies) : ReshapeOperation;

/// <summary>
/// Inserts <paramref name="NewJobSpec"/> immediately after <paramref name="ExistingJobId"/> in the DAG,
/// rewiring all previous successors of the existing job to depend on the new job instead (RS-AFTER-1).
/// </summary>
/// <param name="ExistingJobId">The job whose successors are rewired.</param>
/// <param name="NewJobSpec">The new job inserted between the existing job and its successors.</param>
public sealed record AddAfter(JobId ExistingJobId, JobNode NewJobSpec) : ReshapeOperation;
