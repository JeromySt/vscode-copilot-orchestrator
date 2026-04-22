// <copyright file="SloRegressionGate.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Benchmarks;

/// <summary>INV-4 / INV-5: Compares benchmark results against committed baselines and fails on regression.</summary>
internal sealed class SloRegressionGate
{
    private const double LatencyRegressionPercent = 10.0;
    private const double AllocationRegressionPercent = 5.0;

    private readonly IBenchmarkResultReader reader;

    public SloRegressionGate()
        : this(new FileBenchmarkResultReader())
    {
    }

    public SloRegressionGate(IBenchmarkResultReader reader)
    {
        ArgumentNullException.ThrowIfNull(reader);
        this.reader = reader;
    }

    /// <summary>Runs the regression gate against the supplied results directory and baseline directory.</summary>
    public async ValueTask<RegressionReport> RunAsync(AbsolutePath benchmarkResultsDir, AbsolutePath baselineDir, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var current = await this.reader.ReadAllAsync(benchmarkResultsDir, ct).ConfigureAwait(false);
        var baseline = await this.reader.ReadAllAsync(baselineDir, ct).ConfigureAwait(false);

        var findings = ImmutableArray.CreateBuilder<RegressionFinding>();
        foreach (var (id, currentResult) in current)
        {
            if (!baseline.TryGetValue(id, out var baselineResult))
            {
                continue;
            }

            var basP99 = baselineResult.P99Ns;
            var curP99 = currentResult.P99Ns;
            if (basP99 > 0)
            {
                var deltaPct = ((double)(curP99 - basP99) / basP99) * 100.0;
                if (deltaPct > LatencyRegressionPercent)
                {
                    findings.Add(new RegressionFinding
                    {
                        BenchmarkId = id,
                        BaselineP99 = TimeSpan.FromTicks(basP99 / 100),
                        CurrentP99 = TimeSpan.FromTicks(curP99 / 100),
                        DeltaPercent = Math.Round(deltaPct, 2),
                        Kind = "latency",
                        BaselineAllocatedBytes = baselineResult.AllocatedBytes,
                        CurrentAllocatedBytes = currentResult.AllocatedBytes,
                    });
                }
            }

            var basAlloc = baselineResult.AllocatedBytes;
            var curAlloc = currentResult.AllocatedBytes;
            if (basAlloc > 0)
            {
                var allocDeltaPct = ((double)(curAlloc - basAlloc) / basAlloc) * 100.0;
                if (allocDeltaPct > AllocationRegressionPercent)
                {
                    findings.Add(new RegressionFinding
                    {
                        BenchmarkId = id,
                        BaselineP99 = TimeSpan.FromTicks(basP99 / 100),
                        CurrentP99 = TimeSpan.FromTicks(curP99 / 100),
                        DeltaPercent = Math.Round(allocDeltaPct, 2),
                        Kind = "allocation",
                        BaselineAllocatedBytes = basAlloc,
                        CurrentAllocatedBytes = curAlloc,
                    });
                }
            }
        }

        return new RegressionReport { Regressions = findings.ToImmutable() };
    }
}

/// <summary>Reader abstraction so tests can supply in-memory data without filesystem I/O.</summary>
internal interface IBenchmarkResultReader
{
    ValueTask<IReadOnlyDictionary<string, BenchmarkResult>> ReadAllAsync(AbsolutePath dir, CancellationToken ct);
}

/// <summary>Single benchmark measurement parsed from JSON.</summary>
internal sealed record BenchmarkResult
{
    public required string BenchmarkId { get; init; }

    public required long P50Ns { get; init; }

    public required long P99Ns { get; init; }

    public required long AllocatedBytes { get; init; }
}

internal sealed class FileBenchmarkResultReader : IBenchmarkResultReader
{
    public async ValueTask<IReadOnlyDictionary<string, BenchmarkResult>> ReadAllAsync(AbsolutePath dir, CancellationToken ct)
    {
        var map = new Dictionary<string, BenchmarkResult>(StringComparer.Ordinal);
        var path = dir.ToString();
        if (!Directory.Exists(path))
        {
            return map;
        }

        foreach (var file in Directory.EnumerateFiles(path, "*.json", SearchOption.AllDirectories))
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                var text = await File.ReadAllTextAsync(file, ct).ConfigureAwait(false);
                var parsed = JsonSerializer.Deserialize<BenchmarkResult>(text, SerializerOptions);
                if (parsed is not null && !string.IsNullOrEmpty(parsed.BenchmarkId))
                {
                    map[parsed.BenchmarkId] = parsed;
                }
            }
            catch (JsonException)
            {
                // Skip non-baseline JSON files (BDN emits other structures too).
            }
        }

        return map;
    }

    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
    };
}
