// <copyright file="EventVersionGeneratorContractTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using System.Reflection;
using Xunit;

namespace AiOrchestrator.Eventing.Generators.Tests;

[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    public ContractTestAttribute(string id) => this.Id = id;

    public string Id { get; }
}

public sealed class EventVersionGeneratorContractTests
{
    private const string OneVersionWithMigration = """
        using AiOrchestrator.Models.Eventing;
        namespace Demo
        {
            [EventV("Demo.Order", 1)] public sealed record OrderV1(string Id);
            [EventV("Demo.Order", 2)] public sealed record OrderV2(string Id, string Currency);
            public sealed class OrderMigration1To2 : IEventMigration<OrderV1, OrderV2>
            {
                public OrderV2 Migrate(OrderV1 from) => new(from.Id, "USD");
            }
        }
    """;

    [Fact]
    [ContractTest("EV-GEN-1")]
    public void EVGEN_1_RegistryIncludesAllVersions()
    {
        var result = GeneratorHarness.Run(OneVersionWithMigration);

        Assert.Empty(result.GeneratorDiagnostics);
        Assert.True(result.GeneratedSources.ContainsKey("EventTypeRegistry.g.cs"));
        var registry = result.GeneratedSources["EventTypeRegistry.g.cs"];
        Assert.Contains("\"Demo.Order\", 1", registry);
        Assert.Contains("\"Demo.Order\", 2", registry);
        Assert.Contains("global::Demo.OrderV1", registry);
        Assert.Contains("global::Demo.OrderV2", registry);
    }

    [Fact]
    [ContractTest("EV-GEN-2")]
    public void EVGEN_2_MissingMigrationFailsBuild()
    {
        const string source = """
            using AiOrchestrator.Models.Eventing;
            namespace Demo
            {
                [EventV("Demo.Order", 1)] public sealed record OrderV1(string Id);
                [EventV("Demo.Order", 2)] public sealed record OrderV2(string Id, string Currency);
            }
        """;

        var result = GeneratorHarness.Run(source);

        Assert.Contains(result.GeneratorDiagnostics, d => d.Id == "EVGEN001");
        var diag = result.GeneratorDiagnostics.First(d => d.Id == "EVGEN001");
        Assert.Equal(Microsoft.CodeAnalysis.DiagnosticSeverity.Error, diag.Severity);
        Assert.Contains("EVGEN001", diag.Descriptor.HelpLinkUri);
    }

    [Fact]
    [ContractTest("EV-GEN-3")]
    public void EVGEN_3_GeneratedAcceptanceTestsCoverAllVersions()
    {
        var result = GeneratorHarness.Run(OneVersionWithMigration);

        Assert.True(result.GeneratedSources.ContainsKey("EventVersionAcceptanceTests.g.cs"));
        var src = result.GeneratedSources["EventVersionAcceptanceTests.g.cs"];
        Assert.Contains("Demo.Order/v1.json", src);
        Assert.Contains("Demo.Order/v2.json", src);
        Assert.Contains("EventVersionAcceptanceCases", src);
    }

    [Fact]
    [ContractTest("EVGEN002")]
    public void EVGEN_4_DuplicateVersion_FailsBuild()
    {
        const string source = """
            using AiOrchestrator.Models.Eventing;
            namespace Demo
            {
                [EventV("Demo.Order", 1)] public sealed record OrderV1A(string Id);
                [EventV("Demo.Order", 1)] public sealed record OrderV1B(string Id);
            }
        """;

        var result = GeneratorHarness.Run(source);

        Assert.Contains(result.GeneratorDiagnostics, d => d.Id == "EVGEN002");
        Assert.Contains("EVGEN002", result.GeneratorDiagnostics.First(d => d.Id == "EVGEN002").Descriptor.HelpLinkUri);
    }

    [Fact]
    [ContractTest("EVGEN003")]
    public void EVGEN_5_VersionGap_FailsBuild()
    {
        const string source = """
            using AiOrchestrator.Models.Eventing;
            namespace Demo
            {
                [EventV("Demo.Order", 1)] public sealed record OrderV1(string Id);
                [EventV("Demo.Order", 3)] public sealed record OrderV3(string Id);
            }
        """;

        var result = GeneratorHarness.Run(source);

        Assert.Contains(result.GeneratorDiagnostics, d => d.Id == "EVGEN003");
        Assert.Contains("EVGEN003", result.GeneratorDiagnostics.First(d => d.Id == "EVGEN003").Descriptor.HelpLinkUri);
    }

    [Fact]
    [ContractTest("EVGEN-DETERM")]
    public void EVGEN_6_GeneratorIsDeterministic()
    {
        var first = GeneratorHarness.Run(OneVersionWithMigration);
        var second = GeneratorHarness.Run(OneVersionWithMigration);

        Assert.Equivalent(second.GeneratedSources.Keys, first.GeneratedSources.Keys);
        foreach (var key in first.GeneratedSources.Keys)
        {
            Assert.Equal(first.GeneratedSources[key], second.GeneratedSources[key]);
        }
    }

    [Fact]
    [ContractTest("EVGEN-NOEXT")]
    public void EVGEN_7_GeneratorReadsNoExternalState()
    {
        // The generator assembly must not depend on filesystem types.
        var asm = typeof(EventVersionGenerator).Assembly;
        var ioTypes = asm.GetTypes()
            .SelectMany(t => t.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            .SelectMany(SafeGetLocalTypes)
            .Where(t => t.Namespace == "System.IO" && (t.Name == "File" || t.Name == "Directory" || t.Name == "FileStream" || t.Name == "StreamReader" || t.Name == "StreamWriter"))
            .ToList();

        Assert.Empty(ioTypes);

        // And the type must be IIncrementalGenerator, not ISourceGenerator.
        Assert.True(typeof(Microsoft.CodeAnalysis.IIncrementalGenerator).IsAssignableFrom(typeof(EventVersionGenerator)));
        Assert.False(typeof(Microsoft.CodeAnalysis.ISourceGenerator).IsAssignableFrom(typeof(EventVersionGenerator)));
    }

    private static System.Collections.Generic.IEnumerable<Type> SafeGetLocalTypes(MethodInfo m)
    {
        try
        {
            var body = m.GetMethodBody();
            if (body == null) return System.Linq.Enumerable.Empty<Type>();
            return body.LocalVariables.Select(v => v.LocalType);
        }
        catch
        {
            return System.Linq.Enumerable.Empty<Type>();
        }
    }
}
