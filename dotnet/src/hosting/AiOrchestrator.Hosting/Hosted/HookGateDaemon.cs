// <copyright file="HookGateDaemon.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Diagnostics.CodeAnalysis;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;

namespace AiOrchestrator.Hosting.Hosted;

/// <summary>
/// Background service that manages the authorization hook gate lifecycle.
/// Must be the first hosted service to start and the last to stop.
/// </summary>
[ExcludeFromCodeCoverage]
internal sealed class HookGateDaemon : BackgroundService
{
    /// <inheritdoc/>
    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        return Task.Delay(Timeout.InfiniteTimeSpan, stoppingToken);
    }
}
