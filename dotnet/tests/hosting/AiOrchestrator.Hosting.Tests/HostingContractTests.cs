// <copyright file="HostingContractTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Paths;
using AiOrchestrator.Abstractions.Telemetry;
using AiOrchestrator.Eventing;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using Xunit;
using IAbstractionsClock = AiOrchestrator.Abstractions.Time.IClock;
using IAbstractionsDelay = AiOrchestrator.Abstractions.Time.IDelayProvider;
using IConfigProvider = AiOrchestrator.Abstractions.Configuration.IConfigurationProvider;

namespace AiOrchestrator.Hosting.Tests;

[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    public ContractTestAttribute(string id) => this.Id = id;

    public string Id { get; }
}

public sealed class HostingContractTests
{
    private static IConfiguration BuildConfig(IEnumerable<KeyValuePair<string, string?>>? overrides = null)
    {
        var builder = new ConfigurationBuilder();

        if (overrides is not null)
        {
            builder.AddInMemoryCollection(overrides);
        }

        return builder.Build();
    }

    private static IServiceCollection BuildServices(
        AiOrchestratorOptions? options = null,
        IConfiguration? config = null)
    {
        config ??= BuildConfig();
        var services = new ServiceCollection();
        _ = HostBuilderExtensions.AddAiOrchestrator(services, config, options ?? new AiOrchestratorOptions
        {
            StoreRoot = new AbsolutePath(System.IO.Path.GetTempPath()),
        });
        return services;
    }

    // -------------------------------------------------------------------------
    // H-1: All known domain interfaces are registered
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("H-1")]
    public void H1_AllDomainInterfacesAreRegistered()
    {
        IServiceCollection services = BuildServices();

        Assert.Contains(services, d => d.ServiceType == typeof(IAbstractionsClock));
        Assert.Contains(services, d => d.ServiceType == typeof(IAbstractionsDelay));
        Assert.Contains(services, d => d.ServiceType == typeof(IFileSystem));
        Assert.Contains(services, d => d.ServiceType == typeof(IPathValidator));
        Assert.Contains(services, d => d.ServiceType == typeof(ITelemetrySink));
        Assert.Contains(services, d => d.ServiceType == typeof(IEventBus));
        Assert.Contains(services, d => d.ServiceType == typeof(IEventStore));
        Assert.Contains(services, d => d.ServiceType == typeof(IEventReader));
        Assert.Contains(services, d => d.ServiceType == typeof(IConfigProvider));
    }

    // -------------------------------------------------------------------------
    // H-2: No Abstractions interface implemented by Hosting assembly
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("H-2")]
    public void H2_HostingAssemblyDoesNotImplementAbstractionsInterfaces()
    {
        IServiceCollection services = BuildServices();

        Assembly hostingAssembly = typeof(HostBuilderExtensions).Assembly;
        Assembly abstractionsAssembly = typeof(IEventBus).Assembly;

        foreach (ServiceDescriptor descriptor in services)
        {
            if (descriptor.ServiceType.Assembly != abstractionsAssembly)
            {
                continue;
            }

            Type? implementationType = descriptor.ImplementationType
                ?? descriptor.ImplementationInstance?.GetType();

            if (implementationType is not null)
            {
                Assert.NotEqual(
                    hostingAssembly.GetName().Name,
                    implementationType.Assembly.GetName().Name);
            }
        }
    }

    // -------------------------------------------------------------------------
    // H-3: Hosted services registered in declared start order
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("H-3")]
    public void H3_HostedServicesRegisteredInOrder()
    {
        IServiceCollection services = BuildServices();
        using ServiceProvider sp = services.BuildServiceProvider();

        List<string> names = sp.GetServices<IHostedService>()
            .Select(s => s.GetType().Name)
            .ToList();

        int hookGateIndex = names.IndexOf("HookGateDaemon");
        int brokerIndex = names.IndexOf("ConcurrencyBrokerService");
        int schedulerIndex = names.IndexOf("PlanSchedulerService");

        Assert.True(hookGateIndex >= 0, "HookGateDaemon must be registered");
        Assert.True(brokerIndex >= 0, "ConcurrencyBrokerService must be registered");
        Assert.True(schedulerIndex >= 0, "PlanSchedulerService must be registered");

        Assert.True(hookGateIndex < brokerIndex, "HookGateDaemon must start before ConcurrencyBrokerService");
        Assert.True(brokerIndex < schedulerIndex, "ConcurrencyBrokerService must start before PlanSchedulerService");
    }

    // -------------------------------------------------------------------------
    // H-4: Graceful shutdown stops hosted services in reverse registration order
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("H-4")]
    public async Task H4_ShutdownStopsServicesInReverseOrder()
    {
        var stopLog = new List<string>();

        var services = new ServiceCollection();
        _ = services.AddSingleton<IHostedService>(new TestHostedService("First", stopLog));
        _ = services.AddSingleton<IHostedService>(new TestHostedService("Second", stopLog));
        _ = services.AddSingleton<IHostedService>(new TestHostedService("Third", stopLog));

        ServiceProvider sp = services.BuildServiceProvider();
        var root = new AiOrchestratorRoot(sp);

        await root.DisposeAsync();

        Assert.Equal(new[] { "Third", "Second", "First" }, stopLog);
    }

    // -------------------------------------------------------------------------
    // H-5: Disabled components are not registered
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("H-5")]
    public void H5_DisabledComponentsNotRegistered()
    {
        IServiceCollection services = BuildServices(
            options: new AiOrchestratorOptions
            {
                StoreRoot = new AbsolutePath(System.IO.Path.GetTempPath()),
                EnableHookGate = false,
                EnableConcurrencyBroker = false,
                EnablePluginLoader = false,
            });

        using ServiceProvider sp = services.BuildServiceProvider();

        List<string> names = sp.GetServices<IHostedService>()
            .Select(s => s.GetType().Name)
            .ToList();

        Assert.DoesNotContain("HookGateDaemon", names);
        Assert.DoesNotContain("ConcurrencyBrokerService", names);
        Assert.DoesNotContain("PlanSchedulerService", names);
    }

    // -------------------------------------------------------------------------
    // H-6: Configuration values reach the options layer
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("H-6")]
    public void H6_ConfigurationValuesReachOptionsLayer()
    {
        IConfiguration config = BuildConfig(new Dictionary<string, string?>
        {
            ["Eventing:PerSubscriptionBufferSize"] = "2048",
        });

        IServiceCollection services = BuildServices(config: config);
        using ServiceProvider sp = services.BuildServiceProvider();

        IOptionsMonitor<EventBusOptions> monitor = sp.GetRequiredService<IOptionsMonitor<EventBusOptions>>();
        Assert.Equal(2048, monitor.CurrentValue.PerSubscriptionBufferSize);
    }

    private sealed class TestHostedService : IHostedService
    {
        private readonly string name;
        private readonly List<string> log;

        public TestHostedService(string name, List<string> log)
        {
            this.name = name;
            this.log = log;
        }

        public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

        public Task StopAsync(CancellationToken cancellationToken)
        {
            this.log.Add(this.name);
            return Task.CompletedTask;
        }
    }
}
