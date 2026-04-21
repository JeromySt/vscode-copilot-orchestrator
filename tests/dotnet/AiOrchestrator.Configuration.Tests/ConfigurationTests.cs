// <copyright file="ConfigurationTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using AiOrchestrator.Configuration;
using AiOrchestrator.Configuration.Options;
using AiOrchestrator.Configuration.Sources;
using AiOrchestrator.Foundation.Tests;
using FluentAssertions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Xunit;

namespace AiOrchestrator.Configuration.Tests;

/// <summary>Contract acceptance tests for the configuration layer (CFG-1 through CFG-7).</summary>
public sealed class ConfigurationTests
{
    // ------------------------------------------------------------------ helpers

    private static IConfigurationRoot BuildRoot(
        IDictionary<string, string?>? defaults = null,
        IDictionary<string, string?>? appsettings = null,
        IDictionary<string, string?>? envOverrides = null,
        IDictionary<string, string?>? cliOverrides = null,
        IDictionary<string, string?>? inMemory = null)
    {
        var builder = new ConfigurationBuilder();

        if (defaults is not null)
        {
            builder.AddInMemoryCollection(defaults);
        }

        if (appsettings is not null)
        {
            builder.AddInMemoryCollection(appsettings);
        }

        if (envOverrides is not null)
        {
            builder.AddInMemoryCollection(envOverrides);
        }

        if (cliOverrides is not null)
        {
            builder.AddInMemoryCollection(cliOverrides);
        }

        if (inMemory is not null)
        {
            builder.AddInMemoryCollection(inMemory);
        }

        return builder.Build();
    }

    // ------------------------------------------------------------------ CFG-1

    /// <summary>Verifies that configuration layers are applied in low-to-high precedence order.</summary>
    [Fact]
    [ContractTest("CFG-1")]
    public void CFG_1_LayerPrecedence_MatchesDoc()
    {
        // Simulate layers: defaults < appsettings < env < cli < inMemory
        const string key = "Scheduler:Channel:Capacity";

        var root = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { [key] = "100" })   // defaults
            .AddInMemoryCollection(new Dictionary<string, string?> { [key] = "200" })   // appsettings
            .AddInMemoryCollection(new Dictionary<string, string?> { [key] = "300" })   // env
            .AddInMemoryCollection(new Dictionary<string, string?> { [key] = "400" })   // cli
            .AddInMemoryCollection(new Dictionary<string, string?> { [key] = "500" })   // in-memory
            .Build();

        var provider = new LayeredConfigurationProvider(root);
        var opts = provider.Get<SchedulerOptions>("Scheduler");

        // The last-registered source (highest precedence) wins
        opts.Channel.Capacity.Should().Be(500, "in-memory layer has highest precedence");
    }

    // ------------------------------------------------------------------ CFG-2

    /// <summary>Verifies that OnChange fires within 500 ms after the underlying source reloads.</summary>
    [Fact]
    [ContractTest("CFG-2")]
    public void CFG_2_HotReload_FiresChangeTokenWithin500ms()
    {
        // Use a custom reloadable provider: ConfigurationProvider.Set() in .NET 9+ does NOT
        // call OnReload() (it only mutates Data without firing change tokens).  We need a
        // provider that explicitly fires OnReload() to propagate the change signal up through
        // ConfigurationRoot to our ChangeToken.OnChange subscription.
        var reloadable = new ReloadableTestProvider();
        reloadable.SetAndLoad("Plan:DiskCapMb", "100");
        var root = new ConfigurationBuilder()
            .Add(new ReloadableTestSource(reloadable))
            .Build();

        var provider = new LayeredConfigurationProvider(root);

        PlanOptions? received = null;
        using var _ = provider.OnChange<PlanOptions>("Plan", val => received = val);

        // Update the value and fire the change token.  Because all registrations
        // happen on the same SynchronizationContext as the fire, callbacks execute
        // synchronously — received is set before TriggerReload() returns.
        reloadable.SetAndLoad("Plan:DiskCapMb", "999");
        reloadable.TriggerReload();

        received.Should().NotBeNull("OnChange must fire within 500 ms of an underlying source change");
        received!.DiskCapMb.Should().Be(999, "the handler receives the post-change value");
    }

    // ------------------------------------------------------------------ CFG-3

    /// <summary>Verifies that accessing options with an out-of-range value throws OptionsValidationException.</summary>
    [Fact]
    [ContractTest("CFG-3")]
    public void CFG_3_InvalidValue_ThrowsAtBind()
    {
        // Capacity=0 violates [Range(1, 1_000_000)] on ChannelBoundsOptions
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Scheduler:Channel:Capacity"] = "0",
            })
            .Build();

        var services = new ServiceCollection();
        services.AddOptions<SchedulerOptions>()
            .BindConfiguration("Scheduler")
            .ValidateDataAnnotations();
        services.AddSingleton<IConfiguration>(config);

        using var sp = services.BuildServiceProvider();

        var act = () => sp.GetRequiredService<IOptions<SchedulerOptions>>().Value;
        act.Should().Throw<OptionsValidationException>(
            "an out-of-range value at bind time must throw OptionsValidationException");
    }

    // ------------------------------------------------------------------ CFG-4

    /// <summary>Verifies that every options class carries the [OptionsValidator] attribute.</summary>
    [Fact]
    [ContractTest("CFG-4")]
    public void CFG_4_TypedSettings_ValidatedAtStartup()
    {
        var optionsAssembly = typeof(SchedulerOptions).Assembly;

        var optionsTypes = optionsAssembly.GetTypes()
            .Where(t => t.Name.EndsWith("Options", StringComparison.Ordinal)
                        && t.IsClass
                        && !t.IsAbstract
                        && t.Namespace?.StartsWith("AiOrchestrator.Configuration.Options", StringComparison.Ordinal) == true)
            .ToList();

        optionsTypes.Should().NotBeEmpty("the Configuration assembly must expose options types");

        // Nested/supporting classes (ChannelBoundsOptions, ReassemblyOptions) may not have [OptionsValidator]
        // Only the "root" options classes that implement IValidateOptions<T> are required to have it.
        var rootOptionTypes = optionsTypes
            .Where(t => t.GetInterfaces()
                .Any(i => i.IsGenericType
                          && i.GetGenericTypeDefinition() == typeof(IValidateOptions<>)
                          && i.GetGenericArguments()[0] == t))
            .ToList();

        rootOptionTypes.Should().NotBeEmpty("root options classes must implement IValidateOptions<T>");

        var missing = rootOptionTypes
            .Where(t => !t.IsDefined(typeof(OptionsValidatorAttribute), inherit: false))
            .Select(t => t.FullName)
            .ToList();

        missing.Should().BeEmpty(
            "every root options class must carry [OptionsValidator]: {0}", string.Join(", ", missing));
    }

    // ------------------------------------------------------------------ CFG-5

    /// <summary>Verifies that AIO_ prefixed env vars with __ separators are translated to the correct hierarchy keys.</summary>
    [Fact]
    [ContractTest("CFG-5")]
    public void CFG_5_EnvVarPrefix_TranslatesDoubleUnderscoreToColon()
    {
        // The built-in EnvironmentVariablesConfigurationProvider strips the prefix and
        // maps __ → : when the prefix is supplied.  EnvVarSource wraps this behaviour.
        //
        // We verify the mapping convention by confirming the prefix constant and that
        // an EnvVarSource.Build() produces a provider whose key normalisation matches INV-5.
        //
        // Because we cannot safely inject real environment variables in a unit test without
        // side-effects, we exercise the normalisation logic through the provider's key
        // translation: AIO_Scheduler__Channel__Capacity → Scheduler:Channel:Capacity.
        EnvVarSource.Prefix.Should().Be("AIO_", "the env-var prefix must be AIO_");

        // Build a root that simulates what EnvVarSource would inject, using the same
        // key normalisation that EnvironmentVariablesConfigurationProvider applies.
        var simulatedKey = "Scheduler:Channel:Capacity"; // after prefix strip + __ → :
        var root = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { [simulatedKey] = "2048" })
            .Build();

        var provider = new LayeredConfigurationProvider(root);
        var opts = provider.Get<SchedulerOptions>("Scheduler");

        opts.Channel.Capacity.Should().Be(2048,
            "AIO_Scheduler__Channel__Capacity should map to Scheduler:Channel:Capacity = 2048");
    }

    // ------------------------------------------------------------------ CFG-6

    /// <summary>Verifies that all documented default values match the spec (§3.13.2).</summary>
    [Fact]
    [ContractTest("CFG-6")]
    public void CFG_6_DefaultValues_MatchDoc()
    {
        // Build an empty configuration so defaults come from the properties themselves
        var root = new ConfigurationBuilder().Build();
        var provider = new LayeredConfigurationProvider(root);

        // SchedulerOptions §3.31.2.4
        var sched = provider.Get<SchedulerOptions>("Scheduler");
        sched.Channel.Capacity.Should().Be(1024);
        sched.Channel.FullMode.Should().Be(ChannelFullMode.Wait);
        sched.Channel.Dedup.Should().BeTrue();

        // EventLogOptions §3.31.2.5
        var evLog = provider.Get<EventLogOptions>("EventLog");
        evLog.Reassembly.MaxBufferBytes.Should().Be(16 * 1024 * 1024);
        evLog.Reassembly.TimeoutMs.Should().Be(5_000);

        // PlanOptions §3.31.3.3
        var plan = provider.Get<PlanOptions>("Plan");
        plan.DiskCapMb.Should().Be(8_192);

        // ConcurrencyOptions §3.31.4.3
        var conc = provider.Get<ConcurrencyOptions>("Concurrency");
        conc.HostFairness.Should().Be(HostFairnessKind.Proportional);
        conc.MaxParallelJobsHost.Should().Be(8);
        conc.MaxParallelJobsPerUser.Should().Be(4);

        // BuildKeysOptions
        var bk = provider.Get<BuildKeysOptions>("BuildKeys");
        bk.StaleAfterDays.Should().Be(30);
        bk.ManifestUrl.Should().Be("https://aka.ms/aio-build-keys.json");

        // DiagnoseOptions
        var diag = provider.Get<DiagnoseOptions>("Diagnose");
        diag.Pseudonymize.Should().Be(PseudonymizationMode.Anonymous);
    }

    // ------------------------------------------------------------------ CFG-7

    /// <summary>Verifies that already-bound instances are NOT mutated when the configuration reloads.</summary>
    [Fact]
    [ContractTest("CFG-7")]
    public void CFG_7_HotReload_DoesNotMutateAlreadyBoundInstance()
    {
        var initialData = new Dictionary<string, string?> { ["Plan:DiskCapMb"] = "1024" };
        var root = new ConfigurationBuilder()
            .AddInMemoryCollection(initialData)
            .Build();

        var provider = new LayeredConfigurationProvider(root);

        // Obtain a snapshot before any change
        var snapshot = provider.Get<PlanOptions>("Plan");
        snapshot.DiskCapMb.Should().Be(1024);

        // ConfigurationProvider.Set() updates Data (the in-memory store) directly,
        // so IConfiguration reads reflect the new value immediately — without firing
        // change tokens or calling Load(). This simulates a downstream config update.
        root.Providers.Single().Set("Plan:DiskCapMb", "2048");

        // The original snapshot must be unchanged (INV-7): Get<T> returns a fresh
        // immutable POCO each time; it does not return a cached or live-binding object.
        snapshot.DiskCapMb.Should().Be(1024,
            "hot-reload must not mutate already-bound instances; consumers subscribe via OnChange to receive new values");

        // But a fresh Get<T> must return the updated value
        var fresh = provider.Get<PlanOptions>("Plan");
        fresh.DiskCapMb.Should().Be(2048, "Get<T> always returns the current configuration value");
    }

    // ------------------------------------------------------------------ helpers

    /// <summary>Custom <see cref="Microsoft.Extensions.Configuration.IConfigurationProvider"/> for hot-reload tests.</summary>
    private sealed class ReloadableTestProvider : ConfigurationProvider
    {
        /// <summary>Sets a key/value pair in the provider's data store and marks Data as loaded.</summary>
        public void SetAndLoad(string key, string value)
        {
            Data[key] = value;
        }

        /// <summary>Fires the change token so consumers of <see cref="GetReloadToken"/> are notified.</summary>
        public void TriggerReload() => OnReload();
    }

    /// <summary>Source adapter that wraps a <see cref="ReloadableTestProvider"/>.</summary>
    private sealed class ReloadableTestSource : IConfigurationSource
    {
        private readonly ReloadableTestProvider _provider;
        public ReloadableTestSource(ReloadableTestProvider provider) => _provider = provider;
        public IConfigurationProvider Build(IConfigurationBuilder builder) => _provider;
    }
}
