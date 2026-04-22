// <copyright file="EventVersionGeneratorContractTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using System.Reflection;
using FluentAssertions;
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

        result.GeneratorDiagnostics.Should().BeEmpty();
        result.GeneratedSources.Should().ContainKey("EventTypeRegistry.g.cs");
        var registry = result.GeneratedSources["EventTypeRegistry.g.cs"];
        registry.Should().Contain("\"Demo.Order\", 1");
        registry.Should().Contain("\"Demo.Order\", 2");
        registry.Should().Contain("global::Demo.OrderV1");
        registry.Should().Contain("global::Demo.OrderV2");
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

        result.GeneratorDiagnostics.Should().Contain(d => d.Id == "EVGEN001");
        var diag = result.GeneratorDiagnostics.First(d => d.Id == "EVGEN001");
        diag.Severity.Should().Be(Microsoft.CodeAnalysis.DiagnosticSeverity.Error);
        diag.Descriptor.HelpLinkUri.Should().Contain("EVGEN001");
    }

    [Fact]
    [ContractTest("EV-GEN-3")]
    public void EVGEN_3_GeneratedAcceptanceTestsCoverAllVersions()
    {
        var result = GeneratorHarness.Run(OneVersionWithMigration);

        result.GeneratedSources.Should().ContainKey("EventVersionAcceptanceTests.g.cs");
        var src = result.GeneratedSources["EventVersionAcceptanceTests.g.cs"];
        src.Should().Contain("Demo.Order/v1.json");
        src.Should().Contain("Demo.Order/v2.json");
        src.Should().Contain("EventVersionAcceptanceCases");
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

        result.GeneratorDiagnostics.Should().Contain(d => d.Id == "EVGEN002");
        result.GeneratorDiagnostics.First(d => d.Id == "EVGEN002").Descriptor.HelpLinkUri.Should().Contain("EVGEN002");
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

        result.GeneratorDiagnostics.Should().Contain(d => d.Id == "EVGEN003");
        result.GeneratorDiagnostics.First(d => d.Id == "EVGEN003").Descriptor.HelpLinkUri.Should().Contain("EVGEN003");
    }

    [Fact]
    [ContractTest("EVGEN-DETERM")]
    public void EVGEN_6_GeneratorIsDeterministic()
    {
        var first = GeneratorHarness.Run(OneVersionWithMigration);
        var second = GeneratorHarness.Run(OneVersionWithMigration);

        first.GeneratedSources.Keys.Should().BeEquivalentTo(second.GeneratedSources.Keys);
        foreach (var key in first.GeneratedSources.Keys)
        {
            second.GeneratedSources[key].Should().Be(first.GeneratedSources[key], because: $"generator must be deterministic for hint '{key}'");
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

        ioTypes.Should().BeEmpty(because: "generator must not perform filesystem IO outside the compilation");

        // And the type must be IIncrementalGenerator, not ISourceGenerator.
        typeof(Microsoft.CodeAnalysis.IIncrementalGenerator).IsAssignableFrom(typeof(EventVersionGenerator)).Should().BeTrue();
        typeof(Microsoft.CodeAnalysis.ISourceGenerator).IsAssignableFrom(typeof(EventVersionGenerator)).Should().BeFalse();
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
