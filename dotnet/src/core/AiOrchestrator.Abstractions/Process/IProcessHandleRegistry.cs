// <copyright file="IProcessHandleRegistry.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Abstractions.Process;

/// <summary>
/// Thread-safe registry that tracks <see cref="IProcessHandle"/> instances
/// by plan and job, allowing MCP tools and other consumers to query the
/// process tree of running jobs.
/// </summary>
public interface IProcessHandleRegistry
{
    /// <summary>Registers a process handle for a running job.</summary>
    /// <param name="planId">The plan that owns the job.</param>
    /// <param name="jobId">The job identifier (UUID or producerId).</param>
    /// <param name="handle">The process handle to register.</param>
    void Register(PlanId planId, string jobId, IProcessHandle handle);

    /// <summary>Removes a previously registered handle.</summary>
    /// <param name="planId">The plan that owns the job.</param>
    /// <param name="jobId">The job identifier.</param>
    void Unregister(PlanId planId, string jobId);

    /// <summary>Retrieves the active process handle for a job, or <see langword="null"/> if not tracked.</summary>
    /// <param name="planId">The plan that owns the job.</param>
    /// <param name="jobId">The job identifier.</param>
    /// <returns>The handle, or <see langword="null"/> if the job is not running or not tracked.</returns>
    IProcessHandle? Get(PlanId planId, string jobId);
}
