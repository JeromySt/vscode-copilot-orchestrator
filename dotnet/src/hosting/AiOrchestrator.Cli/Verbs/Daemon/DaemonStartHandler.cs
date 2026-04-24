// <copyright file="DaemonStartHandler.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.CommandLine;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Cli.Verbs.Daemon;

/// <summary>Handler for <c>aio daemon start</c>.</summary>
internal sealed class DaemonStartHandler : VerbBase
{
    public DaemonStartHandler(IServiceProvider services)
        : base(services)
    {
    }

    /// <inheritdoc/>
    public override string VerbPath => "daemon start";

    protected override string Description => "Start the orchestrator daemon (job 34 provides the implementation).";

    protected override async Task<int> RunAsync(ParseResult result, CancellationToken ct)
    {
        await this.WriteVerbResultAsync(result, new VerbResult(this.VerbPath, false, "daemon subsystem not yet installed", CliExitCodes.DaemonUnavailable), ct).ConfigureAwait(false);
        return CliExitCodes.DaemonUnavailable;
    }
}
