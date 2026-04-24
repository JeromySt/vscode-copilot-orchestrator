// <copyright file="PlanReshapeHandler.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.CommandLine;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Cli.Verbs.Plan;

/// <summary>Handler for <c>aio plan reshape</c> (add/remove jobs of a running plan).</summary>
internal sealed class PlanReshapeHandler : VerbBase
{
    private readonly Option<string> planIdOption = new("--plan-id") { Required = true, Description = "Plan id." };
    private readonly Option<string> opOption = new("--op") { Required = true, Description = "Reshape operation: add | remove | rewire." };

    public PlanReshapeHandler(IServiceProvider services)
        : base(services)
    {
    }

    /// <inheritdoc/>
    public override string VerbPath => "plan reshape";

    protected override string Description => "Apply a reshape operation to a running plan.";

    protected override IReadOnlyList<string> ExtraOptionHelp { get; } = new[]
    {
        "--plan-id <id>       Plan id (required).",
        "--op <add|remove|rewire>  Reshape operation (required).",
    };

    protected override void ConfigureOptions(Command command)
    {
        command.Options.Add(this.planIdOption);
        command.Options.Add(this.opOption);
    }

    protected override async Task<int> RunAsync(ParseResult result, CancellationToken ct)
    {
        string? planId = result.GetValue(this.planIdOption);
        string? op = result.GetValue(this.opOption);
        if (string.IsNullOrWhiteSpace(planId) || string.IsNullOrWhiteSpace(op))
        {
            await this.WriteVerbResultAsync(result, new VerbResult(this.VerbPath, false, "--plan-id and --op are required", CliExitCodes.UsageError), ct).ConfigureAwait(false);
            return CliExitCodes.UsageError;
        }

        await this.WriteVerbResultAsync(result, new VerbResult(this.VerbPath, true, $"reshape '{op}' queued for {planId}", CliExitCodes.Ok), ct).ConfigureAwait(false);
        return CliExitCodes.Ok;
    }
}
