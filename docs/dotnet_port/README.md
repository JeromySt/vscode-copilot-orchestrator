# .NET Port — Job Specifications

This folder breaks `docs/DOTNET_CORE_REARCHITECTURE_PLAN.md` (the source-of-truth design document, ~6620 lines, v1.4) into **44 ordered jobs across 11 tiers** for execution by the Copilot Orchestrator.

> **Single source of truth:** every job links back into the design doc by `§section.id`. Job specs do **not** duplicate design content — they pin scope, dependencies, exact API surface, behavioral invariants, acceptance tests, file paths, analyzer/DI constraints, and **mandatory non-AI post-checks** that must mechanically pass before the job is allowed to merge.

## Execution model

- **Tiers** are layers of the dependency DAG. All jobs in tier *N* may run in parallel and all must complete before any job in tier *N+1* starts.
- **Inside each job**, work follows TDD (red contract test → thin implementation → green → next thin slice).
- **Each job opens a worktree, commits its changes, and merges back into `pre-release/1.0.0`** (the planned `baseBranch` and `targetBranch`).
- **`maxParallel = 8`** matches the width of Tier 2 (the bottleneck tier).
- **Every job ends with an explicit post-check phase** — the orchestrator invokes a deterministic shell script that runs the listed scans/builds/tests; ANY non-zero exit fails the job and triggers auto-heal.

## Standing post-check matrix (applies to EVERY job unless explicitly waived)

These checks run after every job as `postchecks`. Each command must exit 0. The orchestrator records the exit code and stdout in the job audit record.

| # | Check | Command (PowerShell) |
|---|---|---|
| **PC-1** | Solution still builds clean with `-warnaserror` | `dotnet build src/dotnet/AiOrchestrator.sln -warnaserror -nologo` |
| **PC-2** | All tests in the touched project pass | `dotnet test tests/dotnet/<project>.Tests --nologo --no-build --logger "trx;LogFileName=results.trx"` |
| **PC-3** | Coverage ≥ 95 % line, ≥ 85 % branch on touched project | `pwsh ./scripts/dotnet/check-coverage.ps1 -Project <project> -MinLine 95 -MinBranch 85` |
| **PC-4** | Zero analyzer diagnostics in OE0001-OE0046 range on touched project | `pwsh ./scripts/dotnet/check-analyzers.ps1 -Project <project>` |
| **PC-5** | Format conformance | `dotnet format src/dotnet/AiOrchestrator.sln --verify-no-changes --no-restore` |
| **PC-6** | No banned APIs reintroduced (DateTime.UtcNow, Process.Start, raw fs/git/vscode imports outside their owning project) | `pwsh ./scripts/dotnet/check-banned-apis.ps1 -Project <project>` |
| **PC-7** | Every test name listed in the job's "Acceptance tests" section is present and tagged `[ContractTest("RULE-ID")]` | `pwsh ./scripts/dotnet/check-contract-tests.ps1 -JobSpec docs/dotnet_port/job_<NNN>.md` |
| **PC-8** | Public API surface change is reviewed (new public types/methods listed in the job spec match what landed) | `pwsh ./scripts/dotnet/check-public-api.ps1 -Project <project> -ExpectedFromSpec docs/dotnet_port/job_<NNN>.md` |
| **PC-9** | Composition-root registration exists for every new DI-managed concrete type | `pwsh ./scripts/dotnet/check-composition.ps1 -Project <project>` |
| **PC-10** | Snapshot-validation: full solution build + full test sweep passes (auto-injected by orchestrator at end of plan) | n/a — managed by orchestrator |

> Job-specific post-checks **add to** this list and are listed under each job's `## Post-checks` section. The standing matrix is implicit; per-job specs only repeat a check if the parameters differ.

### Helper script contracts

The PowerShell helper scripts referenced above MUST be created by **job 000** (foundation) under `scripts/dotnet/`. Each is a thin wrapper documented in `scripts/dotnet/README.md`. Every script:
- exits 0 on success, 1 on failure;
- writes a structured JSON report to `$env:TEMP/aio-postcheck-<name>-<jobId>.json`;
- never modifies source files (read-only).

## DAG (high level)

```
T0 (foundation) → T1 (contracts ‖×3) → T2 (cross-cutting infra ‖×8) →
  ├── T3 (eventing ‖×4) ──┐
  ├── T4 (crypto/git/auth ‖×5) ──┐
  └── T5 (concurrency/shell ‖×3) ─┤
                                  ├── T6 (output+agent+plugins ‖×3) →
                                  ├── T7 (plan/job ‖×5) →
                                  ├── T8 (hosts ‖×5) →
                                  ├── T9 (operational features ‖×4) →
                                  └── T10 (acceptance + release ‖×3 → final)
```

## Job index

| Tier | Jobs | Theme |
|---|---|---|
| **T0** | 00 | Solution foundation, csproj layout, baseline analyzers, post-check helper scripts |
| **T1** | 01–03 | Contracts: domain models, abstractions, test kit |
| **T2** | 04–11 | Cross-cutting infrastructure (logging, config, redaction, paths, clock, fs, process, analyzers) |
| **T3** | 12–15 | Eventing & in-memory state |
| **T4** | 16–20 | Crypto, audit, credentials, git, worktree-lease, hook-gate |
| **T5** | 21–23 | Concurrency brokers + shell execution |
| **T6** | 24–26 | Output pipeline, agent runners, plugins |
| **T7** | 27–31 | Plan / job state machine, scheduler, phase executor |
| **T8** | 32–36 | Hosting + CLI + daemon + MCP + N-API binding |
| **T9** | 37–40 | Diagnose, plan-portability, skew-manifest, VS Code extension transport |
| **T10** | 41–43 | Acceptance suite, benchmarks, release pipeline |

## Standing rules (enforced by analyzers + post-checks)

1. **DI discipline.** No `new ConcreteService()` outside the composition root project (`AiOrchestrator.Composition`). Enforced by **OE0002** + **PC-9**.
2. **No vscode imports.** No `Microsoft.VisualStudio.*` / `vscode` outside the VS Code extension transport. **OE0003**.
3. **No direct fs/process/git** in business-logic projects. Use `IFileSystem`, `IProcessSpawner`, `IGitOperations`. **OE0004 / OE0005 / OE0006**.
4. **TDD.** Every public type ships with at least one test that fails before it exists.
5. **No `Thread.Sleep` / `DateTime.UtcNow` / `Environment.TickCount`** in production code (use `IClock`, `IDelayProvider`). **OE0010**.
6. **Coverage gate ≥ 95 % line / 85 % branch** on touched project (PC-3).
7. **No `dynamic` / `object`** parameters in public APIs. **OE0020**.
8. **Source generators preferred over reflection** for serialization. **OE0040**.
9. **Async methods carry `CancellationToken`.** **OE0007**.
10. **Public APIs documented (XML doc).** **OE0001**.

## Acceptance test naming

Tests carry the rule id from the design doc as part of the test name (e.g., `KEY_ROT_1_AuditChainSurvivesUpdate`, `HK_GATE_LINK_3_BindMountSurvivesPriviledgeDrop`). They are tagged `[ContractTest("RULE-ID")]`. The acceptance job (41) gates the whole port on every named test from §§3.27 – 3.33 being present and green.

## File-tree convention

```
src/dotnet/
  AiOrchestrator.Models/                  # T1 job 01
  AiOrchestrator.Abstractions/            # T1 job 02
  AiOrchestrator.TestKit/                 # T1 job 03
  AiOrchestrator.Logging/                 # T2 job 04
  AiOrchestrator.Configuration/           # T2 job 05
  AiOrchestrator.Redaction/               # T2 job 06
  AiOrchestrator.Paths/                   # T2 job 07
  AiOrchestrator.Time/                    # T2 job 08
  AiOrchestrator.FileSystem/              # T2 job 09
  AiOrchestrator.Process/                 # T2 job 10
  AiOrchestrator.Analyzers/               # T2 job 11
  AiOrchestrator.Eventing/                # T3 jobs 12, 14
  AiOrchestrator.EventLog/                # T3 job 13
  AiOrchestrator.LineView/                # T3 job 15
  AiOrchestrator.Audit/                   # T4 job 16
  AiOrchestrator.Credentials/             # T4 job 17
  AiOrchestrator.Git/                     # T4 job 18
  AiOrchestrator.WorktreeLease/           # T4 job 19
  AiOrchestrator.HookGate/                # T4 job 20
  AiOrchestrator.Concurrency/             # T5 jobs 21, 22
  AiOrchestrator.Shell/                   # T5 job 23
  AiOrchestrator.Output/                  # T6 job 24
  AiOrchestrator.Agent/                   # T6 job 25
  AiOrchestrator.Plugins/                 # T6 job 26
  AiOrchestrator.Plan.Models/             # T7 job 27
  AiOrchestrator.Plan.Store/              # T7 job 28
  AiOrchestrator.Plan.Reshape/            # T7 job 29
  AiOrchestrator.Plan.Scheduler/          # T7 job 30
  AiOrchestrator.Plan.PhaseExec/          # T7 job 31
  AiOrchestrator.Hosting/                 # T8 job 32
  AiOrchestrator.Cli/                     # T8 job 33
  AiOrchestrator.Daemon/                  # T8 job 34
  AiOrchestrator.Mcp/                     # T8 job 35
  AiOrchestrator.Bindings.Node/           # T8 job 36
  AiOrchestrator.Diagnose/                # T9 job 37
  AiOrchestrator.PlanPortability/         # T9 job 38
  AiOrchestrator.SkewManifest/            # T9 job 39
  AiOrchestrator.VsCode.Transport/        # T9 job 40
  AiOrchestrator.Composition/             # populated incrementally per tier
tests/dotnet/                             # mirrors src/dotnet layout
acceptance/dotnet/                        # T10 job 41
benchmarks/dotnet/                        # T10 job 42
release/                                  # T10 job 43
scripts/dotnet/                           # T0 job 00 (post-check helpers)
```

## How an implementing agent should read a job spec

1. Read **Goal** + **Source-doc sections** to ground in the design doc.
2. Read **Public API surface** to understand exactly what types/methods to add (no scope creep).
3. Read **Behavioral invariants** — these are testable claims the implementation must uphold.
4. Read **Acceptance tests** — write these *first* (TDD red phase), then implement, then watch them go green.
5. Run **Post-checks** locally before declaring done. The orchestrator will run them again as gates.
6. If a post-check fails, do **not** weaken the check — fix the implementation. The check is the contract.
