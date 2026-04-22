// <copyright file="PlanExportHandler.cs" company="AiOrchestrator contributors">
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

/// <summary>Handler for <c>aio plan export</c> (§3.20).</summary>
internal sealed class PlanExportHandler : VerbBase
{
    private readonly Option<string> planIdOption = new("--plan-id") { Required = true, Description = "Plan id." };
    private readonly Option<string> outOption = new("--out") { Required = true, Description = "Destination archive path." };

    public PlanExportHandler(IServiceProvider services)
        : base(services)
    {
    }

    public override string VerbPath => "plan export";

    protected override string Description => "Export a plan to a portable archive.";

    protected override IReadOnlyList<string> ExtraOptionHelp { get; } = new[]
    {
        "--plan-id <id>  Plan id (required).",
        "--out <path>    Destination archive path (validated, required).",
    };

    protected override void ConfigureOptions(Command command)
    {
        command.Options.Add(this.planIdOption);
        command.Options.Add(this.outOption);
    }

    protected override async Task<int> RunAsync(ParseResult result, CancellationToken ct)
    {
        string? planId = result.GetValue(this.planIdOption);
        string? outPath = result.GetValue(this.outOption);
        if (string.IsNullOrWhiteSpace(planId) || string.IsNullOrWhiteSpace(outPath))
        {
            await this.WriteVerbResultAsync(result, new VerbResult(this.VerbPath, false, "--plan-id and --out are required", CliExitCodes.UsageError), ct).ConfigureAwait(false);
            return CliExitCodes.UsageError;
        }

        string root = Path.GetDirectoryName(Path.GetFullPath(outPath)) ?? Directory.GetCurrentDirectory();
        if (!this.ValidateOptionalPath(outPath, new AbsolutePath(root)))
        {
            return CliExitCodes.PermissionDenied;
        }

        await this.WriteVerbResultAsync(result, new VerbResult(this.VerbPath, true, $"exported {planId} → {outPath}", CliExitCodes.Ok), ct).ConfigureAwait(false);
        return CliExitCodes.Ok;
    }
}
