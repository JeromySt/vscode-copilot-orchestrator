# Gap Analysis: .NET Port vs TypeScript

> **Branch**: `pre-release/1.0.0` | **Date**: April 2026
>
> This document identifies gaps between the .NET port and the TypeScript
> reference implementation, prioritized by impact on plan execution correctness.

---

## Summary

| Category | TS Status | .NET Status | Priority |
|----------|-----------|-------------|----------|
| Dual JobStatus enums | Single `NodeStatus` (9 values) | Two enums: Models (8) + Plan.Models (7) | **P0** — reconcile |
| Plan status lifecycle | 12 states incl. scaffolding/pausing | 8 states | **P1** — add intermediates |
| Phase ordering | FI first, RI last (7 phases) | FI last (6 phases) | **P1** — align with TS |
| Context pressure | `completed_split` + DAG reshape | Not present | **P2** — complex feature |
| Plan recovery | Dedicated `PlanRecovery` class | Not present | **P2** — needed for resilience |
| Priority scheduling | Retries first → most dependents | Simple filter | **P2** — add priority |
| SV node builder | Full auto-inject + sync | Referenced but stub | **P1** — core feature |
| Execution pump | setTimeout-based with liveness | Channel-based | **P3** — architectural choice |
| Windows crash detection | Specific exit codes | Not present | **P3** — platform-specific |

---

## P0: Must Fix — Correctness Issues

### 1. Dual JobStatus Enum

**Problem**: Two incompatible `JobStatus` enums exist:

| `AiOrchestrator.Models.JobStatus` | `AiOrchestrator.Plan.Models.JobStatus` |
|---|---|
| Pending | Pending (0) |
| Ready | Ready (1) |
| **Scheduled** | — |
| Running | Running (2) |
| Succeeded | Succeeded (3) |
| Failed | Failed (4) |
| **Blocked** | — |
| Canceled | Canceled (5) |
| — | **Skipped (6)** |

**TypeScript reference** (single enum):
```
pending, ready, scheduled, running, completed_split, succeeded, failed, blocked, canceled
```

**Recommendation**: Consolidate into a single enum in `Plan.Models`:
```
Pending, Ready, Scheduled, Running, CompletedSplit, Succeeded, Failed, Blocked, Canceled, Skipped
```
Remove `AiOrchestrator.Models.JobStatus` or make it an alias.

---

## P1: Should Fix — Feature Gaps

### 2. Plan Status Missing Intermediates

TypeScript has 12 plan states; .NET has 8. Missing:

| TS State | Purpose | Recommendation |
|----------|---------|----------------|
| `scaffolding` | Plan being built by scaffolder | Add — needed for UI feedback |
| `pending-start` | Plan scaffolded, waiting for user to start | Add — prevents premature scheduling |
| `pausing` | Pause requested but running jobs haven't finished | Add — avoids race condition |
| `resumed` | Just resumed, scheduler re-evaluating | Add — brief transient state |

### 3. Phase Pipeline Ordering

**TypeScript**: `merge-fi` → `setup` → `prechecks` → `work` → `commit` → `postchecks` → `merge-ri`

**Dotnet**: `Setup` → `Prechecks` → `Work` → `Postchecks` → `Commit` → `ForwardIntegration`

Key differences:
- TS does Forward Integration **first** (merge base into worktree before setup)
- TS does Reverse Integration **last** (merge worktree onto target after postchecks)
- TS runs postchecks **after** commit; dotnet runs postchecks **before** commit
- TS has separate FI/RI; dotnet combines into single FI at the end

**Recommendation**: Align phase order with TS. Add `MergeFi` as phase 0, rename `ForwardIntegration` to `MergeRi`, move postchecks after commit.

### 4. SV Node Builder

TypeScript auto-injects a `__snapshot-validation__` node during scaffolding and keeps its dependencies synchronized via `syncSnapshotValidationDeps()`. The dotnet port has the `T22T14Resolver` but the SV node builder (scaffolding-time injection) appears incomplete.

**Recommendation**: Port `svNodeBuilder.ts` → `SvNodeBuilder.cs` in `Plan.Scheduler`.

### 5. State Transition Validation

TypeScript has an explicit `VALID_TRANSITIONS` lookup table that is checked on every status change. The dotnet `JobStatusTransitions` uses a `FrozenSet` but the enforcement point isn't consistently applied across all code paths.

**Recommendation**: Add `JobStatusTransitions.Validate(from, to)` guard to `PlanStore.MutateAsync()` for `JobStatusUpdated` mutations.

---

## P2: Nice to Have — Advanced Features

### 6. Context Pressure Checkpoint

TypeScript detects when an AI agent's context window is exhausted (`completed_split` status) and reshapes the DAG to split remaining work into sub-jobs. This involves:
- New `completed_split` node status
- `contextPressureCheckpoint` field on execution state
- DAG reshape to fan-out sub-jobs and fan-in validation
- Persisted manifests

**Recommendation**: Defer. This is complex and not needed for v1.0.0. Add `CompletedSplit` to the status enum now for forward compatibility.

### 7. Plan Recovery

TypeScript has a dedicated `PlanRecovery` class that:
- Recovers canceled/failed plans
- Recreates target branch at base commit
- Recovers worktree states from deepest successful nodes
- Optional Copilot agent verification
- Plans enter paused state after recovery

**Recommendation**: Port as `PlanRecoveryService` in `Plan.Scheduler`. Critical for production use but can ship in v1.1.

### 8. Priority Scheduling

TypeScript scheduler prioritizes: retries first → most dependents → alphabetical. The dotnet `ReadySet` returns an unordered set — priority is not applied.

**Recommendation**: Add `PriorityComparer` to `ReadySet.ComputeReady()` or in the scheduler dispatch loop.

---

## P3: Deferred — Architectural Differences

### 9. Execution Architecture

TypeScript uses a monolithic `executeJobNode()` (~700+ lines). Dotnet decomposes into `PhaseExecutor` + `HealOrResumeStrategy` + individual `IPhaseRunner` implementations. **The dotnet design is cleaner** — no action needed.

### 10. Store Architecture

TypeScript uses full-state JSON snapshots per save. Dotnet uses event-sourced checkpoint+journal with idempotency keys. **The dotnet design is more sophisticated** — no action needed.

### 11. Windows Crash Code Detection

TypeScript detects Windows crash codes (0xC0000005 SIGSEGV, 0xC00000FD stack overflow, 0xC0000374 heap corruption) to classify failures. Dotnet's `PhaseFailureKind` has broader categories but doesn't detect specific OS crash codes.

**Recommendation**: Add crash code detection to `PhaseFailureKind.AgentNonZeroExit` classification in a future iteration.

### 12. Execution Pump vs Channel-Based Scheduling

TypeScript uses `setTimeout`-based polling with a liveness watchdog. Dotnet uses `Channel<T>`-based async dispatch. Both are valid; dotnet's approach is more idiomatic for .NET.

---

## Coverage Baseline (68.5% line coverage)

Projects below 60% line coverage that need investment:

| Assembly | Coverage | Action |
|----------|----------|--------|
| Models | 4.2% | Add serialization round-trip tests |
| Configuration | 10.2% | Add options binding tests |
| Abstractions | 21.1% | Add interface contract tests |
| Composition | 36.7% | Add DI registration verification |
| Git | 43.5% | Add shell invoker + bridge tests |
| Process | 48.7% | Add spawner contract tests |
| Plan.PhaseExec | 57.3% | Add phase runner unit tests |
| Mcp | 57.8% | Add MCP tool registration tests |
| Analyzers | 57.6% | Add analyzer diagnostic tests |
| Redaction | 60.8% | Add redaction pattern tests |
