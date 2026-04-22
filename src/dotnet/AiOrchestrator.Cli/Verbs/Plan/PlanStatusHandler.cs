// <copyright file="PlanStatusHandler.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.CommandLine;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Cli.Verbs.Plan;

/// <summary>Handler for <c>aio plan status</c>.</summary>
internal sealed class PlanStatusHandler : VerbBase
{
    private readonly Option<string> planIdOption = new("--plan-id") { Required = true, Description = "Plan id." };

    public PlanStatusHandler(IServiceProvider services)
        : base(services)
    {
    }

    public override string VerbPath => "plan status";

    protected override string Description => "Report the current status of a plan.";

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

        var dto = new PlanStatusDto(planId, "unknown", 0, 0);
        bool json = result.GetValue(this.JsonOption);
        TextWriter writer = Console.Out;
        if (json)
        {
            await new JsonOutputWriter().WriteAsync(dto, writer, CliJsonContext.Default.PlanStatusDto, ct).ConfigureAwait(false);
        }
        else
        {
            string? env = Environment.GetEnvironmentVariable("NO_COLOR");
            await new HumanOutputWriter(result.GetValue(this.NoColorOption), env).WriteAsync(dto, writer, ct).ConfigureAwait(false);
        }

        return CliExitCodes.Ok;
    }
}
