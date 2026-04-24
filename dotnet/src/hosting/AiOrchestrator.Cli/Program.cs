// <copyright file="Program.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.CommandLine;
using AiOrchestrator.Cli.Verbs;
using AiOrchestrator.Cli.Verbs.Daemon;
using AiOrchestrator.Cli.Verbs.Plan;

namespace AiOrchestrator.Cli;

/// <summary>Entry point for the <c>aio</c> CLI (§3.14).</summary>
public sealed class Program
{
    /// <summary>Process entry point.</summary>
    /// <param name="args">Raw command-line arguments.</param>
    /// <returns>A <see cref="CliExitCodes"/> value.</returns>
    public static int Main(string[] args)
    {
        RootCommand root = BuildCommandTree(EmptyServiceProvider.Instance);
        return root.Parse(args ?? Array.Empty<string>()).Invoke();
    }

    /// <summary>Builds the full CLI command tree rooted at <c>aio</c>.</summary>
    /// <param name="sp">The service provider used to resolve verb dependencies (e.g. <see cref="AiOrchestrator.Abstractions.Paths.IPathValidator"/>).</param>
    /// <returns>The constructed <see cref="RootCommand"/>.</returns>
    public static RootCommand BuildCommandTree(IServiceProvider sp)
    {
        ArgumentNullException.ThrowIfNull(sp);

        var root = new RootCommand("aio — AiOrchestrator command-line interface.");

        // plan <verb>
        var planRoot = new Command("plan", "Plan lifecycle verbs.");
        foreach (ICliVerbHandler h in new ICliVerbHandler[]
        {
            new PlanCreateHandler(sp),
            new PlanAddJobHandler(sp),
            new PlanFinalizeHandler(sp),
            new PlanRunHandler(sp),
            new PlanStatusHandler(sp),
            new PlanReshapeHandler(sp),
            new PlanCancelHandler(sp),
            new PlanArchiveHandler(sp),
            new PlanDiagnoseHandler(sp),
            new PlanExportHandler(sp),
            new PlanImportHandler(sp),
        })
        {
            planRoot.Subcommands.Add(h.Build());
        }

        root.Subcommands.Add(planRoot);

        // daemon <verb>
        var daemonRoot = new Command("daemon", "Daemon lifecycle verbs.");
        foreach (ICliVerbHandler h in new ICliVerbHandler[]
        {
            new DaemonStartHandler(sp),
            new DaemonStopHandler(sp),
            new DaemonStatusHandler(sp),
        })
        {
            daemonRoot.Subcommands.Add(h.Build());
        }

        root.Subcommands.Add(daemonRoot);

        // top-level version
        root.Subcommands.Add(new VersionHandler(sp).Build());

        return root;
    }

    /// <summary>
    /// Enumerates every verb handler in the CLI. Used by contract tests (CLI-VERBS)
    /// to assert the full 15-verb surface is registered.
    /// </summary>
    /// <param name="sp">Service provider.</param>
    /// <returns>The handler instances, in canonical order.</returns>
    internal static IReadOnlyList<ICliVerbHandler> EnumerateHandlers(IServiceProvider sp)
    {
        ArgumentNullException.ThrowIfNull(sp);
        return new ICliVerbHandler[]
        {
            new PlanCreateHandler(sp),
            new PlanAddJobHandler(sp),
            new PlanFinalizeHandler(sp),
            new PlanRunHandler(sp),
            new PlanStatusHandler(sp),
            new PlanReshapeHandler(sp),
            new PlanCancelHandler(sp),
            new PlanArchiveHandler(sp),
            new PlanDiagnoseHandler(sp),
            new PlanExportHandler(sp),
            new PlanImportHandler(sp),
            new DaemonStartHandler(sp),
            new DaemonStopHandler(sp),
            new DaemonStatusHandler(sp),
            new VersionHandler(sp),
        };
    }

    private sealed class EmptyServiceProvider : IServiceProvider
    {
        public static readonly EmptyServiceProvider Instance = new();

        /// <inheritdoc/>
        public object? GetService(Type serviceType) => null;
    }
}
