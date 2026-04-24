// <copyright file="OptionsCoverageTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Configuration;
using AiOrchestrator.Configuration.Options;
using AiOrchestrator.Configuration.Sources;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace AiOrchestrator.Configuration.Tests;

/// <summary>Coverage tests for Options classes, Configuration sources, and LayeredConfigurationProvider.</summary>
public sealed class OptionsCoverageTests
{
    // ---- ChannelBoundsOptions ------------------------------------------------

    [Fact]
    public void ChannelBoundsOptions_DefaultCapacity_Is1024()
    {
        var opts = new ChannelBoundsOptions();
        Assert.Equal(1024, opts.Capacity);
    }

    [Fact]
    public void ChannelBoundsOptions_DefaultFullMode_IsWait()
    {
        var opts = new ChannelBoundsOptions();
        Assert.Equal(ChannelFullMode.Wait, opts.FullMode);
    }

    [Fact]
    public void ChannelBoundsOptions_DefaultDedup_IsTrue()
    {
        var opts = new ChannelBoundsOptions();
        Assert.True(opts.Dedup);
    }

    [Fact]
    public void ChannelBoundsOptions_SettersWork()
    {
        var opts = new ChannelBoundsOptions
        {
            Capacity = 512,
            FullMode = ChannelFullMode.DropOldest,
            Dedup = false,
        };
        Assert.Equal(512, opts.Capacity);
        Assert.Equal(ChannelFullMode.DropOldest, opts.FullMode);
        Assert.False(opts.Dedup);
    }

    // ---- ChannelFullMode enum -----------------------------------------------

    [Theory]
    [InlineData(ChannelFullMode.Wait, 0)]
    [InlineData(ChannelFullMode.DropOldest, 1)]
    [InlineData(ChannelFullMode.DropNewest, 2)]
    [InlineData(ChannelFullMode.Throw, 3)]
    public void ChannelFullMode_HasExpectedValues(ChannelFullMode mode, int expected)
    {
        Assert.Equal(expected, (int)mode);
    }

    // ---- BuildKeysOptions ---------------------------------------------------

    [Fact]
    public void BuildKeysOptions_DefaultStaleAfterDays_Is30()
    {
        var opts = new BuildKeysOptions();
        Assert.Equal(30, opts.StaleAfterDays);
    }

    [Fact]
    public void BuildKeysOptions_DefaultManifestUrl_IsNotEmpty()
    {
        var opts = new BuildKeysOptions();
        Assert.False(string.IsNullOrEmpty(opts.ManifestUrl));
        Assert.Contains("build-keys", opts.ManifestUrl);
    }

    [Fact]
    public void BuildKeysOptions_SettersWork()
    {
        var opts = new BuildKeysOptions
        {
            StaleAfterDays = 90,
            ManifestUrl = "https://example.com/keys.json",
        };
        Assert.Equal(90, opts.StaleAfterDays);
        Assert.Equal("https://example.com/keys.json", opts.ManifestUrl);
    }

    // ---- ConcurrencyOptions -------------------------------------------------

    [Fact]
    public void ConcurrencyOptions_DefaultHostFairness_IsProportional()
    {
        var opts = new ConcurrencyOptions();
        Assert.Equal(HostFairnessKind.Proportional, opts.HostFairness);
    }

    [Fact]
    public void ConcurrencyOptions_DefaultMaxParallelJobsHost_Is8()
    {
        var opts = new ConcurrencyOptions();
        Assert.Equal(8, opts.MaxParallelJobsHost);
    }

    [Fact]
    public void ConcurrencyOptions_DefaultMaxParallelJobsPerUser_Is4()
    {
        var opts = new ConcurrencyOptions();
        Assert.Equal(4, opts.MaxParallelJobsPerUser);
    }

    [Fact]
    public void ConcurrencyOptions_SettersWork()
    {
        var opts = new ConcurrencyOptions
        {
            HostFairness = HostFairnessKind.StrictRoundRobin,
            MaxParallelJobsHost = 16,
            MaxParallelJobsPerUser = 8,
        };
        Assert.Equal(HostFairnessKind.StrictRoundRobin, opts.HostFairness);
        Assert.Equal(16, opts.MaxParallelJobsHost);
        Assert.Equal(8, opts.MaxParallelJobsPerUser);
    }

    // ---- HostFairnessKind enum ----------------------------------------------

    [Theory]
    [InlineData(HostFairnessKind.StrictRoundRobin, 0)]
    [InlineData(HostFairnessKind.Proportional, 1)]
    public void HostFairnessKind_HasExpectedValues(HostFairnessKind kind, int expected)
    {
        Assert.Equal(expected, (int)kind);
    }

    // ---- DiagnoseOptions ----------------------------------------------------

    [Fact]
    public void DiagnoseOptions_DefaultPseudonymize_IsAnonymous()
    {
        var opts = new DiagnoseOptions();
        Assert.Equal(PseudonymizationMode.Anonymous, opts.Pseudonymize);
    }

    [Fact]
    public void DiagnoseOptions_SettersWork()
    {
        var opts = new DiagnoseOptions { Pseudonymize = PseudonymizationMode.Full };
        Assert.Equal(PseudonymizationMode.Full, opts.Pseudonymize);
    }

    // ---- PseudonymizationMode enum ------------------------------------------

    [Theory]
    [InlineData(PseudonymizationMode.Anonymous, 0)]
    [InlineData(PseudonymizationMode.Pseudonymized, 1)]
    [InlineData(PseudonymizationMode.Full, 2)]
    public void PseudonymizationMode_HasExpectedValues(PseudonymizationMode mode, int expected)
    {
        Assert.Equal(expected, (int)mode);
    }

    // ---- EventLogOptions ----------------------------------------------------

    [Fact]
    public void EventLogOptions_DefaultReassembly_IsNotNull()
    {
        var opts = new EventLogOptions();
        Assert.NotNull(opts.Reassembly);
    }

    [Fact]
    public void EventLogOptions_DefaultReassembly_HasDefaultMaxBufferBytes()
    {
        var opts = new EventLogOptions();
        Assert.Equal(16 * 1024 * 1024, opts.Reassembly.MaxBufferBytes);
    }

    // ---- ReassemblyOptions --------------------------------------------------

    [Fact]
    public void ReassemblyOptions_DefaultMaxBufferBytes_Is16MB()
    {
        var opts = new ReassemblyOptions();
        Assert.Equal(16 * 1024 * 1024, opts.MaxBufferBytes);
    }

    [Fact]
    public void ReassemblyOptions_DefaultTimeoutMs_Is5000()
    {
        var opts = new ReassemblyOptions();
        Assert.Equal(5000, opts.TimeoutMs);
    }

    [Fact]
    public void ReassemblyOptions_SettersWork()
    {
        var opts = new ReassemblyOptions
        {
            MaxBufferBytes = 1024 * 1024,
            TimeoutMs = 10000,
        };
        Assert.Equal(1024 * 1024, opts.MaxBufferBytes);
        Assert.Equal(10000, opts.TimeoutMs);
    }

    // ---- PlanOptions --------------------------------------------------------

    [Fact]
    public void PlanOptions_DefaultDiskCapMb_Is8192()
    {
        var opts = new PlanOptions();
        Assert.Equal(8192, opts.DiskCapMb);
    }

    [Fact]
    public void PlanOptions_SettersWork()
    {
        var opts = new PlanOptions { DiskCapMb = 1024 };
        Assert.Equal(1024, opts.DiskCapMb);
    }

    // ---- SchedulerOptions ---------------------------------------------------

    [Fact]
    public void SchedulerOptions_DefaultChannel_IsNotNull()
    {
        var opts = new SchedulerOptions();
        Assert.NotNull(opts.Channel);
    }

    [Fact]
    public void SchedulerOptions_DefaultChannel_HasDefaultCapacity()
    {
        var opts = new SchedulerOptions();
        Assert.Equal(1024, opts.Channel.Capacity);
    }

    // ---- LayeredConfigurationProvider ----------------------------------------

    [Fact]
    public void LayeredConfigurationProvider_NullRoot_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => new LayeredConfigurationProvider(null!));
    }

    [Fact]
    public void LayeredConfigurationProvider_Get_ReturnsFreshInstanceForUnknownSection()
    {
        var root = new ConfigurationBuilder().Build();
        var provider = new LayeredConfigurationProvider(root);

        var result = provider.Get<PlanOptions>("NonExistent");
        Assert.NotNull(result);
        Assert.Equal(8192, result.DiskCapMb); // default
    }

    [Fact]
    public void LayeredConfigurationProvider_Get_ThrowsOnNullSection()
    {
        var root = new ConfigurationBuilder().Build();
        var provider = new LayeredConfigurationProvider(root);
        Assert.ThrowsAny<ArgumentException>(() => provider.Get<PlanOptions>(null!));
    }

    [Fact]
    public void LayeredConfigurationProvider_Get_ThrowsOnEmptySection()
    {
        var root = new ConfigurationBuilder().Build();
        var provider = new LayeredConfigurationProvider(root);
        Assert.Throws<ArgumentException>(() => provider.Get<PlanOptions>(string.Empty));
    }

    [Fact]
    public void LayeredConfigurationProvider_OnChange_ThrowsOnNullSection()
    {
        var root = new ConfigurationBuilder().Build();
        var provider = new LayeredConfigurationProvider(root);
        Assert.ThrowsAny<ArgumentException>(() => provider.OnChange<PlanOptions>(null!, _ => { }));
    }

    [Fact]
    public void LayeredConfigurationProvider_OnChange_ThrowsOnNullHandler()
    {
        var root = new ConfigurationBuilder().Build();
        var provider = new LayeredConfigurationProvider(root);
        Assert.Throws<ArgumentNullException>(() => provider.OnChange<PlanOptions>("Plan", null!));
    }

    [Fact]
    public void LayeredConfigurationProvider_OnChange_ReturnsDisposable()
    {
        var root = new ConfigurationBuilder().Build();
        var provider = new LayeredConfigurationProvider(root);
        using var disposable = provider.OnChange<PlanOptions>("Plan", _ => { });
        Assert.NotNull(disposable);
    }

    // ---- CliFlagSource ------------------------------------------------------

    [Fact]
    public void CliFlagSource_NullArgs_ProducesEmptyProvider()
    {
        var source = new CliFlagSource(null);
        var builder = new ConfigurationBuilder();
        var provider = source.Build(builder);
        Assert.NotNull(provider);
    }

    [Fact]
    public void CliFlagSource_WithArgs_ProducesProvider()
    {
        var source = new CliFlagSource(["--Foo=Bar"]);
        var provider = source.Build(new ConfigurationBuilder());
        Assert.NotNull(provider);
    }

    // ---- EnvVarSource -------------------------------------------------------

    [Fact]
    public void EnvVarSource_Prefix_IsAIO_()
    {
        Assert.Equal("AIO_", EnvVarSource.Prefix);
    }

    [Fact]
    public void EnvVarSource_Build_ReturnsProvider()
    {
        var source = new EnvVarSource();
        var provider = source.Build(new ConfigurationBuilder());
        Assert.NotNull(provider);
    }
}
