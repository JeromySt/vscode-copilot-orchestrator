// <copyright file="BenchmarksProgram.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using BenchmarkDotNet.Running;

namespace AiOrchestrator.Benchmarks;

/// <summary>Entry point for the BenchmarkDotNet runner. INV-6: separate `bench` target keeps it out of `dotnet test`.</summary>
public sealed class BenchmarksProgram
{
    /// <summary>BenchmarkDotNet host. Discovers all <c>[Benchmark]</c> classes in this assembly.</summary>
    /// <param name="args">CLI args forwarded to BDN's switcher (e.g. <c>--filter "*EventBus*"</c>, <c>--job short</c>).</param>
    /// <returns>Process exit code (0 on success).</returns>
    public static int Main(string[] args)
    {
        var summaries = BenchmarkSwitcher.FromAssembly(typeof(BenchmarksProgram).Assembly).Run(args);
        foreach (var s in summaries)
        {
            if (s.HasCriticalValidationErrors)
            {
                return 2;
            }
        }

        return 0;
    }
}
