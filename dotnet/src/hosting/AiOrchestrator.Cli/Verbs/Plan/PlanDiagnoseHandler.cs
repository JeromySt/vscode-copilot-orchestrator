// <copyright file="PlanDiagnoseHandler.cs" company="AiOrchestrator contributors">
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

/// <summary>
/// Handler for <c>aio plan diagnose</c>. Produces a portable diagnostic bundle
/// (redactor + pseudonymizer applied per INV-7; actual bundle is produced by job 37).
/// </summary>
internal sealed class PlanDiagnoseHandler : VerbBase
{
    private readonly Option<string> planIdOption = new("--plan-id") { Required = true, Description = "Plan id." };
    private readonly Option<string> outOption = new("--out") { Required = true, Description = "Output path for the diagnostic bundle." };

    public PlanDiagnoseHandler(IServiceProvider services)
        : base(services)
    {
    }

    /// <inheritdoc/>
    public override string VerbPath => "plan diagnose";

    protected override string Description => "Produce a redacted diagnostic bundle for a plan.";

    protected override IReadOnlyList<string> ExtraOptionHelp { get; } = new[]
    {
        "--plan-id <id>  Plan id (required).",
        "--out <path>    Output bundle path (validated via IPathValidator, required).",
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

        await this.WriteVerbResultAsync(result, new VerbResult(this.VerbPath, true, $"diagnose bundle for {planId} → {outPath}", CliExitCodes.Ok), ct).ConfigureAwait(false);
        return CliExitCodes.Ok;
    }
}
