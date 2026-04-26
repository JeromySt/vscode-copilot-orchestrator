// <copyright file="ProcessHandleRegistry.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Concurrent;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Process;

/// <summary>
/// Thread-safe in-memory registry of <see cref="IProcessHandle"/> instances keyed
/// by <c>(PlanId, jobId)</c>. The execution engine registers handles when a job starts
/// and unregisters them when the job completes or is canceled.
/// </summary>
public sealed class ProcessHandleRegistry : IProcessHandleRegistry
{
    private readonly ConcurrentDictionary<(PlanId PlanId, string JobId), IProcessHandle> handles = new();

    /// <inheritdoc/>
    public void Register(PlanId planId, string jobId, IProcessHandle handle)
    {
        ArgumentNullException.ThrowIfNull(handle);
        this.handles[(planId, jobId)] = handle;
    }

    /// <inheritdoc/>
    public void Unregister(PlanId planId, string jobId) =>
        this.handles.TryRemove((planId, jobId), out _);

    /// <inheritdoc/>
    public IProcessHandle? Get(PlanId planId, string jobId) =>
        this.handles.TryGetValue((planId, jobId), out var handle) ? handle : null;
}
