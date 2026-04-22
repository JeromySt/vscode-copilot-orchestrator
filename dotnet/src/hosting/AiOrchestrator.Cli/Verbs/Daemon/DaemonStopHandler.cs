// <copyright file="DaemonStopHandler.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.CommandLine;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Cli.Verbs.Daemon;

/// <summary>Handler for <c>aio daemon stop</c>.</summary>
internal sealed class DaemonStopHandler : VerbBase
{
    public DaemonStopHandler(IServiceProvider services)
        : base(services)
    {
    }

    public override string VerbPath => "daemon stop";

    protected override string Description => "Stop the orchestrator daemon.";

    protected override async Task<int> RunAsync(ParseResult result, CancellationToken ct)
    {
        await this.WriteVerbResultAsync(result, new VerbResult(this.VerbPath, false, "daemon not reachable", CliExitCodes.DaemonUnavailable), ct).ConfigureAwait(false);
        return CliExitCodes.DaemonUnavailable;
    }
}
