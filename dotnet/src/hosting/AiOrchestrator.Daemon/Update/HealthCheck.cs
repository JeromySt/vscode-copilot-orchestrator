// <copyright file="HealthCheck.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Models;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Daemon.Update;

/// <summary>Spawns the freshly-installed daemon with --selfcheck and waits up to 60s.</summary>
internal sealed class HealthCheck
{
    private static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(60);

    private readonly IProcessSpawner spawner;
    private readonly ILogger<HealthCheck> logger;

    public HealthCheck(IProcessSpawner spawner, ILogger<HealthCheck> logger)
    {
        ArgumentNullException.ThrowIfNull(spawner);
        ArgumentNullException.ThrowIfNull(logger);
        this.spawner = spawner;
        this.logger = logger;
    }

    public async ValueTask<HealthResult> RunAsync(AbsolutePath daemonExe, CancellationToken ct)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct);
        linked.CancelAfter(DefaultTimeout);

        try
        {
            var spec = new ProcessSpec
            {
                Producer = "daemon-update",
                Description = "post-update self-check",
                Executable = daemonExe.Value,
                Arguments = ImmutableArray.Create("--selfcheck", "--json"),
            };
            await using var handle = await this.spawner.SpawnAsync(spec, linked.Token).ConfigureAwait(false);
            var exit = await handle.WaitForExitAsync(linked.Token).ConfigureAwait(false);
            if (exit == 0)
            {
                return new HealthResult { Ok = true, FailureReason = null };
            }

            return new HealthResult { Ok = false, FailureReason = $"selfcheck exit code {exit}" };
        }
        catch (OperationCanceledException) when (linked.IsCancellationRequested && !ct.IsCancellationRequested)
        {
            this.logger.LogWarning("Health check timed out after {Seconds}s", DefaultTimeout.TotalSeconds);
            return new HealthResult { Ok = false, FailureReason = "selfcheck timeout" };
        }
    }
}
