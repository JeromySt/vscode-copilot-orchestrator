// <copyright file="PlanCancelHandler.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.CommandLine;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Cli.Verbs.Plan;

/// <summary>Handler for <c>aio plan cancel</c>.</summary>
internal sealed class PlanCancelHandler : VerbBase
{
    private readonly Option<string> planIdOption = new("--plan-id") { Required = true, Description = "Plan id." };

    public PlanCancelHandler(IServiceProvider services)
        : base(services)
    {
    }

    /// <inheritdoc/>
    public override string VerbPath => "plan cancel";

    protected override string Description => "Cancel a running plan.";

    protected override IReadOnlyList<string> ExtraOptionHelp { get; } = new[]
    {
        "--plan-id <id>  Plan id (required).",
    };

    protected override void ConfigureOptions(Command command) => command.Options.Add(this.planIdOption);

    protected override async Task<int> RunAsync(ParseResult result, CancellationToken ct)
    {
        string? planId = result.GetValue(this.planIdOption);
        if (string.IsNullOrWhiteSpace(planId))
        {
            await this.WriteVerbResultAsync(result, new VerbResult(this.VerbPath, false, "--plan-id is required", CliExitCodes.UsageError), ct).ConfigureAwait(false);
            return CliExitCodes.UsageError;
        }

        await this.WriteVerbResultAsync(result, new VerbResult(this.VerbPath, true, $"cancel requested for {planId}", CliExitCodes.PlanCanceled), ct).ConfigureAwait(false);
        return CliExitCodes.PlanCanceled;
    }
}
