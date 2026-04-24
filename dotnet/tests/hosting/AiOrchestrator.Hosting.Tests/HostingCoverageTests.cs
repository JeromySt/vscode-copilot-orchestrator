// <copyright file="HostingCoverageTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Xunit;

namespace AiOrchestrator.Hosting.Tests;

/// <summary>Coverage tests for AiOrchestratorOptions, AiOrchestratorRoot, and HostBuilderExtensions.</summary>
public sealed class HostingCoverageTests
{
    // ---- AiOrchestratorOptions defaults -------------------------------------

    [Fact]
    public void AiOrchestratorOptions_DefaultStoreRoot_IsNotEmpty()
    {
        var opts = new AiOrchestratorOptions();
        Assert.NotNull(opts.StoreRoot);
        Assert.False(string.IsNullOrEmpty(opts.StoreRoot.Value));
    }

    [Fact]
    public void AiOrchestratorOptions_DefaultEnableHookGate_IsTrue()
    {
        var opts = new AiOrchestratorOptions();
        Assert.True(opts.EnableHookGate);
    }

    [Fact]
    public void AiOrchestratorOptions_DefaultEnableConcurrencyBroker_IsTrue()
    {
        var opts = new AiOrchestratorOptions();
        Assert.True(opts.EnableConcurrencyBroker);
    }

    [Fact]
    public void AiOrchestratorOptions_DefaultEnablePluginLoader_IsTrue()
    {
        var opts = new AiOrchestratorOptions();
        Assert.True(opts.EnablePluginLoader);
    }

    [Fact]
    public void AiOrchestratorOptions_DefaultEnableTelemetry_IsFalse()
    {
        var opts = new AiOrchestratorOptions();
        Assert.False(opts.EnableTelemetry);
    }

    [Fact]
    public void AiOrchestratorOptions_WithInit_OverridesDefaults()
    {
        var opts = new AiOrchestratorOptions
        {
            StoreRoot = new AbsolutePath("/custom/path"),
            EnableHookGate = false,
            EnableConcurrencyBroker = false,
            EnablePluginLoader = false,
            EnableTelemetry = true,
        };

        Assert.Equal("/custom/path", opts.StoreRoot.Value);
        Assert.False(opts.EnableHookGate);
        Assert.False(opts.EnableConcurrencyBroker);
        Assert.False(opts.EnablePluginLoader);
        Assert.True(opts.EnableTelemetry);
    }

    // ---- AiOrchestratorRoot -------------------------------------------------

    [Fact]
    public void AiOrchestratorRoot_NullServiceProvider_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => new AiOrchestratorRoot(null!));
    }

    [Fact]
    public void AiOrchestratorRoot_Services_ReturnsSameProvider()
    {
        var services = new ServiceCollection();
        var sp = services.BuildServiceProvider();
        var root = new AiOrchestratorRoot(sp);

        Assert.Same(sp, root.Services);
    }

    [Fact]
    public async Task AiOrchestratorRoot_DisposeAsync_DisposesProvider()
    {
        var services = new ServiceCollection();
        var sp = services.BuildServiceProvider();
        var root = new AiOrchestratorRoot(sp);

        // Should complete without error
        await root.DisposeAsync();
    }

    [Fact]
    public async Task AiOrchestratorRoot_DisposeAsync_StopsHostedServices()
    {
        var services = new ServiceCollection();
        var tracker = new TrackerHostedService();
        services.AddSingleton<IHostedService>(tracker);
        var sp = services.BuildServiceProvider();
        var root = new AiOrchestratorRoot(sp);

        await root.DisposeAsync();

        Assert.True(tracker.StopCalled);
    }

    // ---- HostBuilderExtensions ----------------------------------------------

    [Fact]
    public void UseAiOrchestrator_NullBuilder_Throws()
    {
        Assert.Throws<ArgumentNullException>(() =>
            HostBuilderExtensions.UseAiOrchestrator(null!));
    }

    [Fact]
    public void AddAiOrchestrator_NullServices_Throws()
    {
        var config = new ConfigurationBuilder().Build();
        Assert.Throws<ArgumentNullException>(() =>
            HostBuilderExtensions.AddAiOrchestrator(null!, config));
    }

    [Fact]
    public void AddAiOrchestrator_NullConfig_Throws()
    {
        var services = new ServiceCollection();
        Assert.Throws<ArgumentNullException>(() =>
            HostBuilderExtensions.AddAiOrchestrator(services, null!));
    }

    [Fact]
    public void AddAiOrchestrator_RegistersServices()
    {
        var config = new ConfigurationBuilder().Build();
        var services = new ServiceCollection();
        var result = HostBuilderExtensions.AddAiOrchestrator(services, config);

        Assert.Same(services, result);
        Assert.True(services.Count > 0);
    }

    [Fact]
    public void AddAiOrchestrator_WithDisabledOptions_RegistersFewerHostedServices()
    {
        var config = new ConfigurationBuilder().Build();
        var servicesAll = new ServiceCollection();
        HostBuilderExtensions.AddAiOrchestrator(
            servicesAll,
            config,
            new AiOrchestratorOptions
            {
                StoreRoot = new AbsolutePath(System.IO.Path.GetTempPath()),
                EnableHookGate = true,
                EnableConcurrencyBroker = true,
                EnablePluginLoader = true,
            });

        var servicesNone = new ServiceCollection();
        HostBuilderExtensions.AddAiOrchestrator(
            servicesNone,
            config,
            new AiOrchestratorOptions
            {
                StoreRoot = new AbsolutePath(System.IO.Path.GetTempPath()),
                EnableHookGate = false,
                EnableConcurrencyBroker = false,
                EnablePluginLoader = false,
            });

        int allHosted = servicesAll.Count(d => d.ServiceType == typeof(IHostedService));
        int noneHosted = servicesNone.Count(d => d.ServiceType == typeof(IHostedService));
        Assert.True(allHosted > noneHosted, "Disabling options should register fewer hosted services");
    }

    // ---- Helper classes -----------------------------------------------------

    private sealed class TrackerHostedService : IHostedService
    {
        public bool StopCalled { get; private set; }

        public Task StartAsync(CancellationToken ct) => Task.CompletedTask;

        public Task StopAsync(CancellationToken ct)
        {
            this.StopCalled = true;
            return Task.CompletedTask;
        }
    }
}
