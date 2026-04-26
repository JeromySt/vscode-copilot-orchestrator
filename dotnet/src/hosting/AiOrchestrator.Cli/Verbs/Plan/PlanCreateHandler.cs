// <copyright file="PlanCreateHandler.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.CommandLine;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Cli.Verbs.Plan;

/// <summary>Handler for <c>aio plan create</c> — scaffolds a new plan.</summary>
internal sealed class PlanCreateHandler : VerbBase
{
    private readonly Option<string> nameOption = new("--name")
    {
        Description = "Human-readable plan name.",
        Required = true,
    };

    private readonly Option<string> storeOption = new("--store")
    {
        Description = "Plan store root (absolute path, validated via IPathValidator).",
    };

    public PlanCreateHandler(IServiceProvider services)
        : base(services)
    {
    }

    /// <inheritdoc/>
    public override string VerbPath => "plan create";

    protected override string Description => "Create a new plan in SCAFFOLDING state.";

    protected override IReadOnlyList<string> ExtraOptionHelp { get; } = new[]
    {
        "--name <name>  Human-readable plan name (required).",
        "--store <path> Plan store root; validated via IPathValidator.",
    };

    protected override void ConfigureOptions(Command command)
    {
        command.Options.Add(this.nameOption);
        command.Options.Add(this.storeOption);
    }

    protected override async Task<int> RunAsync(ParseResult result, CancellationToken ct)
    {
        string? name = result.GetValue(this.nameOption);
        if (string.IsNullOrWhiteSpace(name))
        {
            await this.WriteVerbResultAsync(result, new VerbResult(this.VerbPath, false, "--name is required", CliExitCodes.UsageError), ct).ConfigureAwait(false);
            return CliExitCodes.UsageError;
        }

        string? store = result.GetValue(this.storeOption);
        string root = string.IsNullOrEmpty(store) ? Environment.CurrentDirectory : Path.GetFullPath(store);
        if (!this.ValidateOptionalPath(store, new AbsolutePath(root)))
        {
            return CliExitCodes.PermissionDenied;
        }

        await this.WriteVerbResultAsync(result, new VerbResult(this.VerbPath, true, $"plan '{name}' scaffolded at {root}", CliExitCodes.Ok), ct).ConfigureAwait(false);
        return CliExitCodes.Ok;
    }
}
