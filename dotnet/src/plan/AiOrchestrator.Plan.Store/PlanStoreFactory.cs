// <copyright file="PlanStoreFactory.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.IO;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Plan.Store;

/// <summary>
/// Creates and caches <see cref="PlanStore"/> instances per repository root so that a
/// single daemon process can serve multiple repositories concurrently.
/// </summary>
public sealed class PlanStoreFactory : IPlanStoreFactory
{
    private readonly ConcurrentDictionary<string, IPlanStore> stores = new(StringComparer.OrdinalIgnoreCase);
    private readonly IFileSystem fs;
    private readonly IClock clock;
    private readonly IEventBus eventBus;
    private readonly IOptionsMonitor<PlanStoreOptions> options;
    private readonly ILoggerFactory loggerFactory;

    public PlanStoreFactory(
        IFileSystem fs,
        IClock clock,
        IEventBus eventBus,
        IOptionsMonitor<PlanStoreOptions> options,
        ILoggerFactory loggerFactory)
    {
        this.fs = fs ?? throw new ArgumentNullException(nameof(fs));
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.eventBus = eventBus ?? throw new ArgumentNullException(nameof(eventBus));
        this.options = options ?? throw new ArgumentNullException(nameof(options));
        this.loggerFactory = loggerFactory ?? throw new ArgumentNullException(nameof(loggerFactory));
    }

    /// <inheritdoc/>
    public IPlanStore GetStore(string repoRoot)
    {
        ArgumentException.ThrowIfNullOrEmpty(repoRoot);

        return this.stores.GetOrAdd(repoRoot, root =>
            new PlanStore(
                new AbsolutePath(Path.Combine(root, ".orchestrator", "plans")),
                this.fs,
                this.clock,
                this.eventBus,
                this.options,
                this.loggerFactory.CreateLogger<PlanStore>()));
    }
}
