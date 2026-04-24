// <copyright file="PlanAddJobHandler.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.CommandLine;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Cli.Verbs.Plan;

/// <summary>Handler for <c>aio plan add-job</c>.</summary>
internal sealed class PlanAddJobHandler : VerbBase
{
    private readonly Option<string> planIdOption = new("--plan-id") { Required = true, Description = "Plan id." };
    private readonly Option<string> producerIdOption = new("--producer-id") { Required = true, Description = "Stable producer id." };

    public PlanAddJobHandler(IServiceProvider services)
        : base(services)
    {
    }

    /// <inheritdoc/>
    public override string VerbPath => "plan add-job";

    protected override string Description => "Add a job to a scaffolding plan.";

    protected override IReadOnlyList<string> ExtraOptionHelp { get; } = new[]
    {
        "--plan-id <id>      Plan id (required).",
        "--producer-id <id>  Stable producer id for the new job (required).",
    };

    protected override void ConfigureOptions(Command command)
    {
        command.Options.Add(this.planIdOption);
        command.Options.Add(this.producerIdOption);
    }

    protected override async Task<int> RunAsync(ParseResult result, CancellationToken ct)
    {
        string? planId = result.GetValue(this.planIdOption);
        string? producerId = result.GetValue(this.producerIdOption);
        if (string.IsNullOrWhiteSpace(planId) || string.IsNullOrWhiteSpace(producerId))
        {
            await this.WriteVerbResultAsync(result, new VerbResult(this.VerbPath, false, "--plan-id and --producer-id are required", CliExitCodes.UsageError), ct).ConfigureAwait(false);
            return CliExitCodes.UsageError;
        }

        await this.WriteVerbResultAsync(result, new VerbResult(this.VerbPath, true, $"job {producerId} added to {planId}", CliExitCodes.Ok), ct).ConfigureAwait(false);
        return CliExitCodes.Ok;
    }
}
