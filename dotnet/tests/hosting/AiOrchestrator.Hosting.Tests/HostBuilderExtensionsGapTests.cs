// <copyright file="HostBuilderExtensionsGapTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Xunit;

namespace AiOrchestrator.Hosting.Tests;

/// <summary>Gap-filling tests for <see cref="HostBuilderExtensions"/>.</summary>
public sealed class HostBuilderExtensionsGapTests
{
    [Fact]
    public void UseAiOrchestrator_NullBuilder_Throws()
    {
        IHostBuilder builder = null!;
        Assert.Throws<ArgumentNullException>(() => builder.UseAiOrchestrator());
    }

    [Fact]
    public void UseAiOrchestrator_WithConfigureAction_ReturnsSameBuilder()
    {
        var builder = new HostBuilder();
        var result = builder.UseAiOrchestrator(_ => { });

        // UseAiOrchestrator returns the same builder for chaining.
        Assert.Same(builder, result);
    }

    [Fact]
    public void UseAiOrchestrator_NullConfigureAction_ReturnsSameBuilder()
    {
        var builder = new HostBuilder();
        var result = builder.UseAiOrchestrator(null);

        Assert.Same(builder, result);
    }

    [Fact]
    public void AddAiOrchestrator_NullServices_Throws()
    {
        IServiceCollection services = null!;
        var config = new ConfigurationBuilder().Build();

        Assert.Throws<ArgumentNullException>(() => services.AddAiOrchestrator(config));
    }

    [Fact]
    public void AddAiOrchestrator_NullConfig_Throws()
    {
        var services = new ServiceCollection();

        Assert.Throws<ArgumentNullException>(() => services.AddAiOrchestrator(null!));
    }

    [Fact]
    public void AddAiOrchestrator_WithConfigOverrides_AppliesThem()
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Eventing:PerSubscriptionBufferSize"] = "4096",
            })
            .Build();

        var services = new ServiceCollection();
        services.AddAiOrchestrator(config);

        // Should register services without throwing.
        using var sp = services.BuildServiceProvider();
        Assert.NotNull(sp);
    }

    [Fact]
    public void AddAiOrchestrator_AllComponentsEnabled_RegistersAllHostedServices()
    {
        var config = new ConfigurationBuilder().Build();
        var services = HostBuilderExtensions.AddAiOrchestrator(
            new ServiceCollection(),
            config,
            new AiOrchestratorOptions
            {
                StoreRoot = new AbsolutePath(System.IO.Path.GetTempPath()),
                EnableHookGate = true,
                EnableConcurrencyBroker = true,
                EnablePluginLoader = true,
            });

        using var sp = services.BuildServiceProvider();
        var hosted = sp.GetServices<IHostedService>().Select(s => s.GetType().Name).ToList();

        Assert.Contains("HookGateDaemon", hosted);
        Assert.Contains("ConcurrencyBrokerService", hosted);
        Assert.Contains("PlanSchedulerService", hosted);
    }

    [Fact]
    public void AddAiOrchestrator_OnlyHookGateEnabled_RegistersOnlyHookGate()
    {
        var config = new ConfigurationBuilder().Build();
        var services = HostBuilderExtensions.AddAiOrchestrator(
            new ServiceCollection(),
            config,
            new AiOrchestratorOptions
            {
                StoreRoot = new AbsolutePath(System.IO.Path.GetTempPath()),
                EnableHookGate = true,
                EnableConcurrencyBroker = false,
                EnablePluginLoader = false,
            });

        using var sp = services.BuildServiceProvider();
        var hosted = sp.GetServices<IHostedService>().Select(s => s.GetType().Name).ToList();

        Assert.Contains("HookGateDaemon", hosted);
        Assert.DoesNotContain("ConcurrencyBrokerService", hosted);
        Assert.DoesNotContain("PlanSchedulerService", hosted);
    }

    [Fact]
    public void UseAiOrchestrator_ReturnsSameBuilder()
    {
        var builder = new HostBuilder();
        var result = builder.UseAiOrchestrator();

        Assert.Same(builder, result);
    }

    [Fact]
    public void AddAiOrchestrator_ReturnsSameServiceCollection()
    {
        var config = new ConfigurationBuilder().Build();
        var services = new ServiceCollection();
        var result = services.AddAiOrchestrator(config);

        Assert.Same(services, result);
    }
}
