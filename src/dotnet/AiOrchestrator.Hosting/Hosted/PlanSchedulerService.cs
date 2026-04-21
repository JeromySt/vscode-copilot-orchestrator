// <copyright file="PlanSchedulerService.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;

namespace AiOrchestrator.Hosting.Hosted;

/// <summary>
/// Background service responsible for scheduling plan execution against available concurrency slots.
/// Starts last and stops first during host shutdown.
/// </summary>
internal sealed class PlanSchedulerService : BackgroundService
{
    /// <inheritdoc/>
    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        return Task.Delay(Timeout.InfiniteTimeSpan, stoppingToken);
    }
}
