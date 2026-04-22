// <copyright file="EventVersionGenerator.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using AiOrchestrator.Eventing.Generators.Diagnostics;
using Microsoft.CodeAnalysis;

namespace AiOrchestrator.Eventing.Generators;

/// <summary>
/// Roslyn incremental generator implementing event-versioning rules EV-GEN-1..3.
/// </summary>
/// <remarks>
/// Discovers every type marked <c>[EventV(name, version)]</c> in the compilation,
/// emits a frozen <c>EventTypeRegistry</c> and <c>EventMigrationGraph</c>, validates
/// adjacency invariants, and emits per-version acceptance test descriptors.
/// </remarks>
[Generator(LanguageNames.CSharp)]
public sealed class EventVersionGenerator : IIncrementalGenerator
{
    internal const string EventVAttributeFullName = "AiOrchestrator.Models.Eventing.EventVAttribute";
    internal const string EventMigrationInterfaceFullName = "AiOrchestrator.Models.Eventing.IEventMigration`2";

    /// <inheritdoc/>
    public void Initialize(IncrementalGeneratorInitializationContext context)
    {
        var versions = context.SyntaxProvider
            .ForAttributeWithMetadataName(
                EventVAttributeFullName,
                predicate: static (_, _) => true,
                transform: static (ctx, _) => Extract(ctx))
            .Where(static x => x is not null)!
            .Collect();

        var compilationAndVersions = context.CompilationProvider.Combine(versions);

        context.RegisterSourceOutput(compilationAndVersions, static (spc, source) =>
        {
            var compilation = source.Left;
            var collected = source.Right!;

            var validVersions = ValidateAndDeduplicate(spc, collected);

            // Always emit registry/graph/cases (even empty) so consumer code that
            // references them compiles. They are "frozen" at the data we have.
            var tableEmitter = new MigrationTableEmitter();
            spc.AddSource("EventTypeRegistry.g.cs", tableEmitter.Emit(validVersions));
            spc.AddSource("EventMigrationGraph.g.cs", tableEmitter.EmitGraph(validVersions));

            var testsEmitter = new AcceptanceTestEmitter();
            spc.AddSource("EventVersionAcceptanceTests.g.cs", testsEmitter.Emit(validVersions));

            // Verify adjacency: every (N, N+1) edge has a public IEventMigration<TFrom, TTo> impl.
            VerifyMigrations(spc, compilation, validVersions);
        });
    }

    private static EventVersionCandidate? Extract(GeneratorAttributeSyntaxContext ctx)
    {
        if (ctx.TargetSymbol is not INamedTypeSymbol typeSymbol)
        {
            return null;
        }

        foreach (var attr in ctx.Attributes)
        {
            if (attr.ConstructorArguments.Length < 2) continue;
            var nameArg = attr.ConstructorArguments[0];
            var versionArg = attr.ConstructorArguments[1];
            if (nameArg.Value is not string eventTypeName) continue;
            if (versionArg.Value is not int version) continue;

            var fqn = typeSymbol.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
            Location? loc = typeSymbol.Locations.FirstOrDefault() ?? Location.None;
            return new EventVersionCandidate(eventTypeName, version, fqn, loc);
        }

        return null;
    }

    private static IReadOnlyList<EventVersionInfo> ValidateAndDeduplicate(
        SourceProductionContext spc,
        ImmutableArray<EventVersionCandidate?> raw)
    {
        var result = new List<EventVersionInfo>();
        var byName = raw
            .Where(c => c is not null)
            .Cast<EventVersionCandidate>()
            .GroupBy(c => c.EventTypeName, System.StringComparer.Ordinal)
            .OrderBy(g => g.Key, System.StringComparer.Ordinal);

        foreach (var group in byName)
        {
            var ordered = group.OrderBy(g => g.Version).ToList();

            // EVGEN002: duplicates
            var dupGroups = ordered.GroupBy(o => o.Version).Where(g => g.Count() > 1);
            var dupVersions = new HashSet<int>();
            foreach (var dup in dupGroups)
            {
                dupVersions.Add(dup.Key);
                foreach (var c in dup)
                {
                    spc.ReportDiagnostic(Diagnostic.Create(
                        EVGEN002.Descriptor, c.Location, group.Key, dup.Key));
                }
            }

            // EVGEN003: gaps. Expect 1..N contiguous.
            int expected = 1;
            foreach (var c in ordered)
            {
                if (c.Version > expected)
                {
                    spc.ReportDiagnostic(Diagnostic.Create(
                        EVGEN003.Descriptor, c.Location, group.Key, expected, c.Version));
                }

                expected = c.Version + 1;
            }

            // Emit one EventVersionInfo per unique (name, version).
            foreach (var c in ordered.GroupBy(o => o.Version).Select(g => g.First()))
            {
                result.Add(new EventVersionInfo(c.EventTypeName, c.Version, c.FullyQualifiedTypeName));
            }
        }

        return result;
    }

    private static void VerifyMigrations(
        SourceProductionContext spc,
        Compilation compilation,
        IReadOnlyList<EventVersionInfo> versions)
    {
        var migrationOpen = compilation.GetTypeByMetadataName(EventMigrationInterfaceFullName);
        if (migrationOpen is null)
        {
            // The Models project hasn't been referenced yet — nothing to verify.
            return;
        }

        // Collect concrete public types implementing IEventMigration<TFrom, TTo>.
        var implPairs = new HashSet<string>(System.StringComparer.Ordinal);
        var visitor = new ImplementationCollector(migrationOpen, implPairs);
        visitor.Visit(compilation.GlobalNamespace);

        var byName = versions
            .GroupBy(v => v.EventTypeName, System.StringComparer.Ordinal)
            .OrderBy(g => g.Key, System.StringComparer.Ordinal);
        foreach (var group in byName)
        {
            var ordered = group.OrderBy(v => v.Version).ToList();
            for (int i = 0; i + 1 < ordered.Count; i++)
            {
                var from = ordered[i];
                var to = ordered[i + 1];
                var key = from.FullyQualifiedTypeName + "|" + to.FullyQualifiedTypeName;
                if (!implPairs.Contains(key))
                {
                    spc.ReportDiagnostic(Diagnostic.Create(
                        EVGEN001.Descriptor,
                        Location.None,
                        group.Key,
                        from.FullyQualifiedTypeName,
                        to.FullyQualifiedTypeName,
                        from.Version,
                        to.Version));
                }
            }
        }
    }

    private sealed record EventVersionCandidate(
        string EventTypeName,
        int Version,
        string FullyQualifiedTypeName,
        Location Location);

    private sealed class ImplementationCollector : SymbolVisitor
    {
        private readonly INamedTypeSymbol _openMigration;
        private readonly HashSet<string> _pairs;

        public ImplementationCollector(INamedTypeSymbol openMigration, HashSet<string> pairs)
        {
            _openMigration = openMigration;
            _pairs = pairs;
        }

        public override void VisitNamespace(INamespaceSymbol symbol)
        {
            foreach (var member in symbol.GetMembers())
            {
                member.Accept(this);
            }
        }

        public override void VisitNamedType(INamedTypeSymbol symbol)
        {
            if (symbol.DeclaredAccessibility == Accessibility.Public &&
                !symbol.IsAbstract &&
                symbol.TypeKind is TypeKind.Class or TypeKind.Struct)
            {
                foreach (var iface in symbol.AllInterfaces)
                {
                    if (iface.IsGenericType && SymbolEqualityComparer.Default.Equals(iface.OriginalDefinition, _openMigration))
                    {
                        if (iface.TypeArguments.Length == 2)
                        {
                            var from = iface.TypeArguments[0].ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
                            var to = iface.TypeArguments[1].ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
                            _pairs.Add(from + "|" + to);
                        }
                    }
                }
            }

            foreach (var nested in symbol.GetTypeMembers())
            {
                nested.Accept(this);
            }
        }
    }
}
