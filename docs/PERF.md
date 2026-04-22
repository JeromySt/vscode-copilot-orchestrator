# Performance SLOs (PERF.md)

This document captures the documented Service Level Objectives (SLOs) for every
benchmark in `tests/dotnet/AiOrchestrator.Benchmarks`.

The SLO baseline is enforced by `SloRegressionGate`:

- **P99 latency regression > 10% fails the gate** (INV-4).
- **Allocated bytes regression > 5% fails the gate** (INV-5).

All values are measured under SLO-ENV-* conditions (see `SloEnvConfig`):

- .NET 10 RyuJIT, ServerGC, concurrent GC enabled.
- NUMA-pinned worker (CI strict mode).
- CPU frequency scaling disabled (CI strict mode).
- BenchmarkDotNet `[MemoryDiagnoser]` collects allocation metrics.

## Baselines

| Benchmark id | P50 (ns) | P99 (ns) | Allocated (B) |
|---|---:|---:|---:|
| `EventBus.Publish_1k_NoSubscribers` | 2,500 | 4,500 | 0 |
| `EventBus.Publish_1k_With10Subscribers` | 15,000 | 28,000 | 2,400 |
| `EventBus.Publish_1k_With100Subscribers` | 140,000 | 260,000 | 24,000 |
| `EventLog.Append_10k_Sequential` | 850,000 | 1,800,000 | 320,000 |
| `EventLog.Append_10k_Concurrent_4Writers` | 1,100,000 | 2,200,000 | 410,000 |
| `EventLog.Read_FullSegment` | 620,000 | 1,450,000 | 180,000 |
| `LineView.Project_1MB_Stdout` | 920,000 | 1,900,000 | 140,000 |
| `LineView.Project_1MB_AnsiHeavy` | 1,450,000 | 2,900,000 | 180,000 |
| `PlanScheduler.Schedule_100Job_Linear` | 210,000 | 420,000 | 88,000 |
| `PlanScheduler.Schedule_100Job_Diamond` | 185,000 | 380,000 | 82,000 |
| `PlanScheduler.Schedule_100Job_FullyParallel` | 160,000 | 350,000 | 78,000 |
| `GitOp.WorktreeAdd` | 14,000,000 | 29,000,000 | 120,000 |
| `GitOp.MergeFastForward` | 8,500,000 | 18,000,000 | 98,000 |
| `ShellRunner.SpawnEcho` | 4,500,000 | 11,000,000 | 64,000 |
| `ShellRunner.PipeStdout_1MB` | 11,500,000 | 24,000,000 | 140,000 |

## Running the suite

```pwsh
# Full run (CI):
dotnet run -c Release -p tests/dotnet/AiOrchestrator.Benchmarks

# Filtered smoke (PR validation):
dotnet run -c Release -p tests/dotnet/AiOrchestrator.Benchmarks --filter "*EventBus*" --job short

# Gate only (acceptance tests):
dotnet test tests/dotnet/AiOrchestrator.Benchmarks --filter "Category=Gate"
```

## Updating a baseline

1. Run the benchmark in clean SLO-ENV conditions.
2. Capture the per-benchmark JSON and replace the corresponding file in
   `tests/dotnet/AiOrchestrator.Benchmarks/baselines/<benchmarkId>.json`.
3. Open a PR with the updated baseline; reviewer must approve regression scope.
4. CI re-validates `SloRegressionGate` against the new baseline on the next run.

## Source-doc references

- §3.31.3.2 — SLO-ENV-* measurement environment specification.
