// <copyright file="AiOrchestratorRoot.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace AiOrchestrator.Hosting;

/// <summary>
/// Wraps the service provider produced by <see cref="HostBuilderExtensions.UseAiOrchestrator"/>
/// and coordinates a graceful shutdown of all registered hosted services in reverse registration order.
/// </summary>
[ExcludeFromCodeCoverage]
public sealed class AiOrchestratorRoot : IAsyncDisposable
{
    private static readonly TimeSpan ShutdownTimeout = TimeSpan.FromSeconds(30);
    private readonly IServiceProvider sp;

    /// <summary>Initializes a new instance of the <see cref="AiOrchestratorRoot"/> class.</summary>
    /// <param name="sp">The service provider to wrap.</param>
    public AiOrchestratorRoot(IServiceProvider sp)
    {
        ArgumentNullException.ThrowIfNull(sp);
        this.sp = sp;
    }

    /// <summary>Gets the underlying service provider.</summary>
    public IServiceProvider Services => this.sp;

    /// <inheritdoc/>
    public async ValueTask DisposeAsync()
    {
        using var cts = new CancellationTokenSource(ShutdownTimeout);

        IEnumerable<IHostedService> hostedServices = this.sp.GetServices<IHostedService>();
        List<IHostedService> reversed = hostedServices.Reverse().ToList();

        foreach (IHostedService service in reversed)
        {
            try
            {
                await service.StopAsync(cts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Graceful timeout — continue stopping remaining services.
            }
        }

        if (this.sp is IAsyncDisposable asyncDisposable)
        {
            await asyncDisposable.DisposeAsync().ConfigureAwait(false);
        }
        else if (this.sp is IDisposable disposable)
        {
            disposable.Dispose();
        }
    }
}
