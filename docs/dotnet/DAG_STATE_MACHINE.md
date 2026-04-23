# DAG Execution State Machine

> **Branch**: `pre-release/1.0.0` | **Date**: April 2026
>
> This document describes the complete state machine governing plan execution
> in the .NET port of the AI Orchestrator, including DAG structure, job lifecycle,
> phase execution, auto-heal, scheduling, reshape operations, and persistence.

---

## 1. Architecture Overview

```mermaid
graph TB
    subgraph "Plan Store (event-sourced)"
        CP[checkpoint.json]
        JN[journal.ndjson]
    end

    subgraph "Scheduler"
        RS[ReadySet Computation]
        CC[Concurrency Gates]
        CH[Scheduling Channels]
        T22[T22/T14 SV Resolver]
    end

    subgraph "Phase Executor"
        PE[PhaseExecutor]
        HR[HealOrResumeStrategy]
        P1[SetupPhase]
        P2[PrechecksPhase]
        P3[WorkPhase]
        P4[PostchecksPhase]
        P5[CommitPhase]
        P6[ForwardIntegration]
    end

    subgraph "Reshape"
        RO[ReshapeOperations]
        CG[CycleGuard]
        PG[PlanGraph]
    end

    CP --> RS
    JN --> CP
    RS --> CH
    CH --> CC
    CC --> PE
    PE --> P1 --> P2 --> P3 --> P4 --> P5 --> P6
    PE --> HR
    RO --> CG --> PG
    T22 --> RO
```

---

## 2. Job Status State Machine

### 2.1 Status Values

The system defines two `JobStatus` enums (a known discrepancy — see §8 Gap Analysis):

| Source | Values |
|--------|--------|
| `AiOrchestrator.Models.JobStatus` | `Pending`, `Ready`, `Scheduled`, `Running`, `Succeeded`, `Failed`, `Blocked`, `Canceled` |
| `AiOrchestrator.Plan.Models.JobStatus` | `Pending(0)`, `Ready(1)`, `Running(2)`, `Succeeded(3)`, `Failed(4)`, `Canceled(5)`, `Skipped(6)` |

### 2.2 State Transition Diagram

```mermaid
stateDiagram-v2
    [*] --> Pending : Job created

    Pending --> Ready : All predecessors Succeeded
    Pending --> Blocked : Any predecessor Failed/Canceled
    Pending --> Canceled : Plan canceled (INV-10)

    Ready --> Scheduled : Admitted by concurrency gate
    Ready --> Canceled : Plan canceled

    Scheduled --> Running : Phase executor starts
    Scheduled --> Failed : Scheduler error
    Scheduled --> Canceled : CancellationToken

    Running --> Succeeded : All 6 phases complete
    Running --> Failed : GiveUp decision
    Running --> Canceled : CancellationToken

    Failed --> Ready : Retry (reshape re-queue)

    Succeeded --> [*]
    Failed --> [*]
    Blocked --> [*]
    Canceled --> [*]
```

### 2.3 Transition Rules

| From | To | Trigger | Invariant |
|------|----|---------|-----------|
| `Pending` | `Ready` | All predecessors `Succeeded` | INV-2 |
| `Pending` | `Blocked` | Any predecessor `Failed` or `Canceled` | — |
| `Pending` | `Canceled` | Plan-level cancel | INV-10 |
| `Ready` | `Scheduled` | Admitted through concurrency gates | — |
| `Ready` | `Canceled` | Plan-level cancel | INV-10 |
| `Scheduled` | `Running` | PhaseExecutor begins | — |
| `Running` | `Succeeded` | All phases complete (`Done` sentinel) | — |
| `Running` | `Failed` | `HealOrResumeStrategy` returns `GiveUp` | — |
| `Running` | `Canceled` | CancellationToken fired | — |
| `Failed` | `Ready` | Explicit retry via reshape | — |

### 2.4 State Transition Record

Each transition is captured as an immutable record appended to `JobNode.Transitions`:

```csharp
sealed record StateTransition {
    JobStatus From;
    JobStatus To;
    DateTimeOffset OccurredAt;
    string? Reason;
}
```

---

## 3. Plan Status Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Pending : Plan created

    Pending --> Running : First job scheduled
    Running --> Paused : User pause request
    Paused --> Running : Resume
    Running --> Succeeded : All jobs Succeeded
    Running --> Partial : Some Succeeded, some Failed
    Running --> Failed : Critical failure
    Running --> Canceled : User cancel
    Partial --> Archived : Archive
    Succeeded --> Archived : Archive
    Failed --> Archived : Archive
    Canceled --> Archived : Archive

    Archived --> [*]
```

| Status | Meaning |
|--------|---------|
| `Pending` | Created, no jobs scheduled yet |
| `Running` | Actively scheduling and executing jobs |
| `Paused` | No new jobs will be scheduled; running jobs continue |
| `Succeeded` | All jobs completed successfully |
| `Partial` | Some jobs succeeded, others failed |
| `Failed` | Plan-level failure |
| `Canceled` | Externally canceled |
| `Archived` | Terminal, read-only |

---

## 4. DAG Structure

### 4.1 Data Model

```mermaid
classDiagram
    class Plan {
        +string Id
        +string Name
        +string? Description
        +PlanStatus Status
        +DateTimeOffset CreatedAt
        +DateTimeOffset? StartedAt
        +IReadOnlyDictionary~string,JobNode~ Jobs
    }

    class JobNode {
        +string Id
        +string Title
        +JobStatus Status
        +IReadOnlyList~string~ DependsOn
        +WorkSpec? WorkSpec
        +IReadOnlyList~JobAttempt~ Attempts
        +IReadOnlyList~StateTransition~ Transitions
        +DateTimeOffset? StartedAt
        +DateTimeOffset? CompletedAt
    }

    class WorkSpec {
        +string? Instructions
        +IReadOnlyList~string~ AllowedFolders
        +IReadOnlyList~string~ AllowedUrls
        +IReadOnlyList~string~ CheckCommands
    }

    class JobAttempt {
        +int AttemptNumber
        +DateTimeOffset StartedAt
        +DateTimeOffset? CompletedAt
        +JobStatus Status
        +string? ErrorMessage
        +IReadOnlyList~PhaseTiming~ PhaseTimings
    }

    class PhaseTiming {
        +string Phase
        +DateTimeOffset? StartedAt
        +DateTimeOffset? CompletedAt
    }

    Plan "1" --> "*" JobNode : Jobs
    JobNode "1" --> "*" JobAttempt : Attempts
    JobNode "1" --> "*" StateTransition : Transitions
    JobNode "1" --> "0..1" WorkSpec : WorkSpec
    JobAttempt "1" --> "*" PhaseTiming : PhaseTimings
    JobNode "0..*" --> "0..*" JobNode : DependsOn
```

### 4.2 DAG Example

```mermaid
graph LR
    A[Job A: setup-infra] --> C[Job C: deploy-api]
    B[Job B: build-frontend] --> C
    A --> D[Job D: run-migrations]
    D --> C
    C --> SV[__snapshot-validation__]
    B --> SV
```

- **Roots**: Jobs with no predecessors (A, B)
- **Leaves**: Jobs with no successors (excluding SV)
- **SV Node**: `__snapshot-validation__` automatically depends on all leaf nodes

---

## 5. Phase Execution Pipeline

### 5.1 Phase Order (INV-1)

```mermaid
graph LR
    Setup --> Prechecks --> Work --> Postchecks --> Commit --> FI[Forward Integration] --> Done
```

| Phase | Enum Value | Default Timeout | Purpose |
|-------|-----------|----------------|---------|
| **Setup** | 0 | 5 min | Forward-integrate base into worktree, allocate lease |
| **Prechecks** | 1 | 10 min | Validate pre-conditions before agent work |
| **Work** | 2 | 30 min | Invoke the AI agent runner |
| **Postchecks** | 3 | 10 min | Validate that work satisfies post-conditions |
| **Commit** | 4 | 5 min | Stage and commit changes |
| **ForwardIntegration** | 5 | 15 min | Merge target onto worktree for downstream jobs |
| **Done** | 6 | — | Terminal sentinel |

### 5.2 Phase Execution Sequence

```mermaid
sequenceDiagram
    participant S as Scheduler
    participant PE as PhaseExecutor
    participant Setup
    participant Prechecks
    participant Work
    participant Postchecks
    participant Commit
    participant FI as ForwardIntegration
    participant HR as HealOrResume
    participant Store as PlanStore

    S->>PE: Execute(jobId, workSpec, ct)
    PE->>Store: RecordAttempt(jobId, attempt++)

    PE->>Setup: RunAsync(context)
    Setup-->>PE: ✓

    PE->>Prechecks: RunAsync(context)
    Prechecks-->>PE: ✓

    PE->>Work: RunAsync(context)
    alt Work succeeds
        Work-->>PE: ✓
    else Work fails
        Work-->>PE: PhaseExecutionException
        PE->>HR: Classify(failureKind)
        HR-->>PE: AutoHeal / PhaseResume / GiveUp
        alt AutoHeal
            PE->>Work: RunAsync(context + healInstructions)
        else PhaseResume
            PE->>Work: RunAsync(context)
        else GiveUp
            PE->>Store: UpdateStatus(Failed)
        end
    end

    PE->>Postchecks: RunAsync(context)
    Postchecks-->>PE: ✓

    PE->>Commit: RunAsync(context)
    Commit-->>PE: ✓

    PE->>FI: RunAsync(context)
    FI-->>PE: ✓

    PE->>Store: UpdateStatus(Succeeded)
```

### 5.3 Auto-Heal Decision Matrix

```mermaid
graph TD
    F[Phase Failure] --> C{Classify FailureKind}

    C -->|TransientNetwork| PR[PhaseResume]
    C -->|TransientFileLock| PR
    C -->|AgentMaxTurnsExceeded| HC{autoHeal && cap < 3?}
    C -->|AgentNonZeroExit| HC
    C -->|AnalyzerOrTestFailure| HC
    C -->|MergeConflict| HC
    C -->|ShellNonZeroExit| HC
    C -->|RemoteRejected| GU[GiveUp]
    C -->|Timeout| GU
    C -->|Internal| GU

    HC -->|Yes| AH[AutoHeal from Work]
    HC -->|No| GU

    PR --> Retry[Retry same phase]
    AH --> HealWork[Re-run Work with heal instructions]
    GU --> Failed[Job → Failed]
```

| FailureKind | autoHeal=ON, cap < 3 | autoHeal=OFF or cap ≥ 3 |
|-------------|---------------------|------------------------|
| `TransientNetwork` | **PhaseResume** | **PhaseResume** |
| `TransientFileLock` | **PhaseResume** | **PhaseResume** |
| `AgentMaxTurnsExceeded` | **AutoHeal** | **GiveUp** |
| `AgentNonZeroExit` | **AutoHeal** | **GiveUp** |
| `AnalyzerOrTestFailure` | **AutoHeal** | **GiveUp** |
| `MergeConflict` | **AutoHeal** | **GiveUp** |
| `ShellNonZeroExit` | **AutoHeal** | **GiveUp** |
| `RemoteRejected` | **GiveUp** (always) | **GiveUp** |
| `Timeout` | **GiveUp** (always) | **GiveUp** |
| `Internal` | **GiveUp** (always) | **GiveUp** |

**Caps**: `MaxAutoHealAttempts` = 3 (HEAL-RESUME-3), `MaxPhaseResumeAttempts` = 3.

---

## 6. Scheduler

### 6.1 Ready Set Computation

```mermaid
graph TD
    Start[For each Pending job] --> CheckDeps{All predecessors?}
    CheckDeps -->|All Succeeded| READY[Mark Ready]
    CheckDeps -->|Any Failed/Canceled| BLOCKED[Mark Blocked]
    CheckDeps -->|Some still running| WAIT[Stay Pending]
```

**Algorithm** (`ReadySet.ComputeReady`):
```
ready = []
for each job where status == Pending:
    anyTerminalFailure = false
    allSucceeded = true
    for each predecessor:
        if pred.status in {Failed, Canceled}:
            anyTerminalFailure = true; break
        if pred.status != Succeeded:
            allSucceeded = false
    if !anyTerminalFailure && allSucceeded:
        ready.add(job)
return ready
```

### 6.2 Concurrency Control

```mermaid
graph LR
    Ready[Ready Jobs] --> G[Global Semaphore<br/>max 16]
    G --> U[Per-User Limiter]
    U --> H[Host Broker]
    H --> Dispatch[Phase Executor]
```

Three-level admission gate:
1. **Global**: `SchedulerOptions.GlobalMaxParallel` (default 16)
2. **Per-user**: `IPerUserConcurrency` — configurable per-user limit
3. **Host broker**: `IHostConcurrencyBrokerClient` — host-level coordination

### 6.3 T22/T14 SV Resolver

Keeps the Snapshot Validation (SV) node's dependencies synchronized with the current leaf set:

```mermaid
sequenceDiagram
    participant R as Reshaper
    participant T as T22T14Resolver
    participant G as PlanGraph

    R->>T: Resolve(plan, pendingOps)
    T->>G: Apply pending ops
    T->>G: Compute new leaf set
    T->>T: Compare leaf set vs SV.DependsOn
    alt Leaves changed
        T->>T: Rewire SV edges to new leaves
        T-->>R: AdjustedPlan + SvDependencyEdges
    else No change
        T-->>R: Original plan (no-op)
    end
```

---

## 7. Reshape Operations

### 7.1 Operation Types

| Operation | Constraint | Effect |
|-----------|-----------|--------|
| `AddJob` | No duplicate ID, no cycle, not SV | Insert new node |
| `RemoveJob` | Must be Pending/Ready, not SV | Remove node + clean refs |
| `UpdateDeps` | Must be Pending, no cycle, not SV | Replace dependency list |
| `AddBefore` | Existing must be Pending, no cycle | Insert before existing |
| `AddAfter` | Not SV | Insert after existing, rewire successors |

### 7.2 Reshape Sequence

```mermaid
sequenceDiagram
    participant C as Caller
    participant R as PlanReshaper
    participant V as CycleGuard
    participant G as PlanGraph
    participant S as PlanStore

    C->>R: ApplyBatch(planId, operations, idemKey)
    R->>G: Load current plan graph
    loop For each operation
        R->>V: ValidateNoCycle(op, projectedGraph)
        V->>V: Iterative DFS (3-color)
        V-->>R: OK / CycleResult
        R->>G: Project operation onto graph
    end
    R->>S: MutateAsync(mutations, subKeys)
    S-->>R: Updated plan
    R-->>C: ReshapeResult
```

### 7.3 Cycle Detection (CycleGuard)

```mermaid
graph TD
    Start[Project op onto graph copy] --> DFS[Iterative DFS]
    DFS --> Color{Node color?}
    Color -->|Unvisited| Push[Push to stack, mark InStack]
    Color -->|InStack| Cycle[CYCLE DETECTED]
    Color -->|Done| Skip[Skip]
    Push --> Next[Visit neighbors]
    Next --> Color
    Skip --> Pop[Pop stack, mark Done]
    Pop --> Continue[Continue DFS]
    Cycle --> Witness[Extract cycle witness path]
```

### 7.4 Invariants

| ID | Rule |
|----|------|
| RS-TXN-1 | Atomic batch — if ANY op fails, NOTHING persists |
| RS-TXN-2 | Derived sub-keys from single idempotency key |
| INV-6 | Only Pending/Ready jobs can be removed |
| INV-7 | Only Pending jobs can have deps updated |
| RS-AFTER-1 | AddAfter rewires all successors to depend on new node |

---

## 8. Plan Store (Event-Sourced)

### 8.1 Persistence Model

```mermaid
graph LR
    subgraph "Plan Directory"
        CP[checkpoint.json<br/>Full snapshot @ seq N]
        JN[journal.ndjson<br/>Mutations N+1..M]
    end

    Load[Load Plan] --> ReadCP[Read checkpoint]
    ReadCP --> Replay[Replay journal entries > seq N]
    Replay --> Current[Current state @ seq M]

    Mutate[MutateAsync] --> Append[Append to journal]
    Append --> Publish[Publish to watchers]
```

### 8.2 Mutation Types

| Mutation | Fields | Purpose |
|----------|--------|---------|
| `JobAdded` | Node | Add a job to the DAG |
| `JobRemoved` | JobIdValue | Remove a job |
| `JobDepsUpdated` | JobIdValue, NewDeps | Replace dependency list |
| `JobStatusUpdated` | JobIdValue, NewStatus | Change job status |
| `JobAttemptRecorded` | JobIdValue, Attempt | Append execution attempt |
| `PlanStatusUpdated` | NewStatus | Change plan-level status |

### 8.3 Watch (SUB-3)

`WatchAsync()` yields the current snapshot, then live updates after each mutation.
No gaps, no duplicates. Implemented via per-plan `Channel<Plan>` watchers.

### 8.4 Idempotency (RW-2-IDEM)

Every mutation carries an `IdemKey` (content hash). On journal replay, duplicate
keys are silently skipped, enabling safe retry of crashed operations.

---

## 9. Portability

### 9.1 Export Flow

```mermaid
graph LR
    Plan --> Export[PlanExporter]
    Export --> ZIP[.aioplan ZIP]
    ZIP --> Manifest[manifest.json<br/>schema version + SHA-256 hashes]
    ZIP --> PlanJSON[plan.json<br/>serialized plan]
```

- Deterministic ZIP timestamps (epoch 2000-01-01)
- Optional: strip attempts/transitions, redact paths

### 9.2 Import Conflict Policies

| Policy | Behavior |
|--------|----------|
| `Reject` | Throw on ID collision |
| `GenerateNewId` | Assign fresh PlanId (default) |
| `OverwriteIfArchived` | Replace only if existing is Archived |

---

## 10. Complete Job Lifecycle Example

```mermaid
sequenceDiagram
    participant User
    participant Store as PlanStore
    participant Sched as Scheduler
    participant PE as PhaseExecutor
    participant Agent as AI Agent
    participant Git

    User->>Store: Create plan with 3 jobs (A→B→C)
    Store->>Store: JobAdded × 3
    Store->>Sched: Watch notification

    Note over Sched: ReadySet: A is Ready (no deps)
    Sched->>PE: Execute(A)
    PE->>PE: Setup: allocate worktree
    PE->>PE: Prechecks: validate
    PE->>Agent: Work: run AI agent
    Agent-->>PE: Changes committed
    PE->>PE: Postchecks: verify
    PE->>Git: Commit changes
    PE->>Git: Forward-integrate
    PE->>Store: A → Succeeded

    Note over Sched: ReadySet: B is Ready (A succeeded)
    Sched->>PE: Execute(B)
    PE->>Agent: Work: run AI agent
    alt Agent fails
        Agent-->>PE: Exit code 1
        PE->>PE: HealOrResume → AutoHeal
        PE->>Agent: Re-run Work with heal instructions
        Agent-->>PE: ✓ (healed)
    end
    PE->>Store: B → Succeeded

    Note over Sched: ReadySet: C is Ready (A,B succeeded)
    Sched->>PE: Execute(C)
    PE->>Store: C → Succeeded

    Note over Store: All jobs Succeeded → Plan Succeeded
```
