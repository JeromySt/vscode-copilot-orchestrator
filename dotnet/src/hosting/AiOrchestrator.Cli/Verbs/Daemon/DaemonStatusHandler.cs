// <copyright file="DaemonStatusHandler.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.CommandLine;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Cli.Verbs.Daemon;

/// <summary>Handler for <c>aio daemon status</c>.</summary>
internal sealed class DaemonStatusHandler : VerbBase
{
    public DaemonStatusHandler(IServiceProvider services)
        : base(services)
    {
    }

    /// <inheritdoc/>
    public override string VerbPath => "daemon status";

    protected override string Description => "Report the current daemon status.";

    protected override async Task<int> RunAsync(ParseResult result, CancellationToken ct)
    {
        var dto = new DaemonStatusDto(false, -1, "unavailable");
        bool json = result.GetValue(this.JsonOption);
        TextWriter writer = Console.Out;
        if (json)
        {
            await new JsonOutputWriter().WriteAsync(dto, writer, CliJsonContext.Default.DaemonStatusDto, ct).ConfigureAwait(false);
        }
        else
        {
            string? env = Environment.GetEnvironmentVariable("NO_COLOR");
            await new HumanOutputWriter(result.GetValue(this.NoColorOption), env).WriteAsync(dto, writer, ct).ConfigureAwait(false);
        }

        return CliExitCodes.DaemonUnavailable;
    }
}
