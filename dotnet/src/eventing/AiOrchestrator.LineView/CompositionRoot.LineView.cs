// <copyright file="CompositionRoot.LineView.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Diagnostics.CodeAnalysis;
using Microsoft.Extensions.DependencyInjection;

namespace AiOrchestrator.LineView;

/// <summary>DI composition for <see cref="LineProjector"/>.</summary>
[ExcludeFromCodeCoverage]
public static class CompositionRoot
{
    /// <summary>Register LineView services.</summary>
    /// <param name="services">Service collection.</param>
    /// <returns>The same service collection for chaining.</returns>
    public static IServiceCollection AddLineView(IServiceCollection services)
    {
        _ = services.AddTransient<LineProjector>();
        return services;
    }
}
