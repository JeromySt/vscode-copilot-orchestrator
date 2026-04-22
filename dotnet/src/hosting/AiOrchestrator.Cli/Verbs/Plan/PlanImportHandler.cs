// <copyright file="PlanImportHandler.cs" company="AiOrchestrator contributors">
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

/// <summary>Handler for <c>aio plan import</c> (§3.20).</summary>
internal sealed class PlanImportHandler : VerbBase
{
    private readonly Option<string> fromOption = new("--from") { Required = true, Description = "Archive path to import." };

    public PlanImportHandler(IServiceProvider services)
        : base(services)
    {
    }

    public override string VerbPath => "plan import";

    protected override string Description => "Import a plan from a portable archive.";

    protected override IReadOnlyList<string> ExtraOptionHelp { get; } = new[]
    {
        "--from <path>  Archive path (validated, required).",
    };

    protected override void ConfigureOptions(Command command) => command.Options.Add(this.fromOption);

    protected override async Task<int> RunAsync(ParseResult result, CancellationToken ct)
    {
        string? fromPath = result.GetValue(this.fromOption);
        if (string.IsNullOrWhiteSpace(fromPath))
        {
            await this.WriteVerbResultAsync(result, new VerbResult(this.VerbPath, false, "--from is required", CliExitCodes.UsageError), ct).ConfigureAwait(false);
            return CliExitCodes.UsageError;
        }

        string root = Path.GetDirectoryName(Path.GetFullPath(fromPath)) ?? Directory.GetCurrentDirectory();
        if (!this.ValidateOptionalPath(fromPath, new AbsolutePath(root)))
        {
            return CliExitCodes.PermissionDenied;
        }

        await this.WriteVerbResultAsync(result, new VerbResult(this.VerbPath, true, $"imported from {fromPath}", CliExitCodes.Ok), ct).ConfigureAwait(false);
        return CliExitCodes.Ok;
    }
}
