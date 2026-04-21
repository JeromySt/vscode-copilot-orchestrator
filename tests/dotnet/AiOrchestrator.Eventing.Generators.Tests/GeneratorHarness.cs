// <copyright file="GeneratorHarness.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using AiOrchestrator.Eventing.Generators;
using AiOrchestrator.Models.Eventing;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace AiOrchestrator.Eventing.Generators.Tests;

/// <summary>Helpers for driving the <see cref="EventVersionGenerator"/> in-process.</summary>
internal static class GeneratorHarness
{
    public sealed record RunResult(
        Compilation OutputCompilation,
        ImmutableArray<Diagnostic> GeneratorDiagnostics,
        ImmutableArray<Diagnostic> CompilationDiagnostics,
        Dictionary<string, string> GeneratedSources);

    public static RunResult Run(string source) => Run(new[] { source });

    public static RunResult Run(IEnumerable<string> sources)
    {
        var syntaxTrees = sources
            .Select((s, i) => CSharpSyntaxTree.ParseText(s, path: $"src{i}.cs"))
            .ToArray();

        var trustedAssemblies = (string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!;
        var refs = trustedAssemblies
            .Split(Path.PathSeparator)
            .Where(p => !string.IsNullOrEmpty(p))
            .Select(p => MetadataReference.CreateFromFile(p))
            .Concat(new[]
            {
                MetadataReference.CreateFromFile(typeof(EventVAttribute).Assembly.Location),
            })
            .ToList();

        var compilation = CSharpCompilation.Create(
            assemblyName: "TestAsm",
            syntaxTrees: syntaxTrees,
            references: refs,
            options: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable));

        var generator = new EventVersionGenerator();
        var driver = CSharpGeneratorDriver.Create(generator);
        driver = (CSharpGeneratorDriver)driver.RunGeneratorsAndUpdateCompilation(
            compilation, out var outputCompilation, out var generatorDiagnostics);

        var run = driver.GetRunResult();
        var generated = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var result in run.Results)
        {
            foreach (var src in result.GeneratedSources)
            {
                generated[src.HintName] = src.SourceText.ToString();
            }
        }

        var compDiags = outputCompilation.GetDiagnostics();

        return new RunResult(outputCompilation, generatorDiagnostics, compDiags, generated);
    }
}
