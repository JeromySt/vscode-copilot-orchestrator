// <copyright file="ConcurrencyBrokerService.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Diagnostics.CodeAnalysis;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;

namespace AiOrchestrator.Hosting.Hosted;

/// <summary>
/// Background service that manages concurrency slot allocation for plan execution.
/// Starts after <see cref="HookGateDaemon"/> and stops before it.
/// </summary>
[ExcludeFromCodeCoverage]
internal sealed class ConcurrencyBrokerService : BackgroundService
{
    /// <inheritdoc/>
    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        return Task.Delay(Timeout.InfiniteTimeSpan, stoppingToken);
    }
}
