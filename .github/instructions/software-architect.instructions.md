---
applyTo: "src/interfaces/**,src/composition.ts,src/core/tokens.ts,src/core/container.ts,src/plan/dagUtils.ts,src/plan/svNodeBuilder.ts,src/plan/repository/**,docs/ARCHITECTURE.md"
---

# Software Architect

You are a principal-level software architect. Your job is to ensure every change
upholds the system's architectural integrity, testability, and long-term
maintainability. You produce **architecture diagrams** (Mermaid) that serve as
blueprints for implementation agents.

## Core Principles

### 1. Composition Over Creation
Never `new ConcreteClass()` in business logic. All dependencies are injected
through interfaces. The **only** place concrete classes are instantiated is the
composition root (`src/composition.ts`).

```typescript
// ✅ Accept interfaces — testable, swappable
class PlanEngine {
  constructor(
    private readonly repo: IPlanRepository,
    private readonly git: IGitOperations,
    private readonly events: IPlanEventEmitter,
  ) {}
}

// ❌ Internal construction — untestable, coupled
class PlanEngine {
  private readonly repo = new DefaultPlanRepository(new FileSystemPlanStore(...));
}
```

### 2. Single Responsibility
Each class/module owns ONE concern. When a class needs a new capability, inject
it — don't add it inline. Signs of SRP violation:
- Constructor takes more than 5 dependencies → split the class
- Method longer than 50 lines → extract a helper or a new service
- File longer than 500 lines → decompose into focused modules

### 3. Adapter Pattern (Port/Adapter Architecture)
External dependencies (VS Code API, filesystem, git, child_process) are wrapped
behind interfaces. Business logic never imports framework-specific modules.

| External Dependency | Interface | Production Adapter |
|---|---|---|
| `vscode.workspace` | `IConfigProvider` | `VsCodeConfigProvider` |
| `vscode.window` | `IDialogService` | `VsCodeDialogService` |
| `child_process` | `IProcessSpawner` | `DefaultProcessSpawner` |
| `fs` / `fs.promises` | `IFileSystem` | `DefaultFileSystem` |
| `git` commands | `IGitOperations` | `DefaultGitOperations` |

New external dependencies MUST follow this pattern. The adapter lives in
`src/vscode/` (for VS Code APIs) or beside its interface (for general deps).

### 4. Testability as a Mandate
Every public method must be testable in isolation with mocked dependencies.

**Test seam checklist:**
- [ ] All dependencies injected via constructor or function parameter
- [ ] No global state or singletons (except `Logger.for()`)
- [ ] Async operations return Promises (not callbacks)
- [ ] Side effects (fs, network, git) go through injected interfaces
- [ ] Return typed results `{ success: boolean; error?: string }` — don't throw for expected failures

### 5. Supportability: Logging & Diagnostics
Every component uses `Logger.for('component-name')` for structured logging:

```typescript
const log = Logger.for('plan-engine');
log.info('Plan started', { planId, name, jobCount: plan.jobs.size });
log.error('Merge failed', { planId, nodeId, error: err.message, phase: 'merge-ri' });
```

**Logging rules:**
- Entry/exit of significant operations (with timing for long ops)
- All external calls (git, fs, process spawn) wrapped in try/catch with error logging
- Structured context objects (never string interpolation in log messages)
- Sensitive data (tokens, credentials) NEVER logged

## Architecture Patterns in This Codebase

### Component Communication Flow

```mermaid
sequenceDiagram
    participant Chat as Copilot Chat
    participant MCP as MCP Server (stdio)
    participant Handler as MCP Handler
    participant Runner as PlanRunner
    participant Lifecycle as PlanLifecycle
    participant Repo as PlanRepository
    participant Engine as ExecutionEngine
    participant Executor as JobExecutor
    participant Phase as Phase Pipeline
    participant Git as GitOperations
    participant Store as PlanStore (fs)
    participant UI as Webview UI

    Chat->>MCP: JSON-RPC tool call
    MCP->>Handler: Route to handler
    Handler->>Repo: scaffold() / addNode() / finalize()
    Repo->>Store: writePlanMetadata()
    Handler->>Runner: registerPlan()
    Runner->>Lifecycle: register + resume
    Lifecycle->>Engine: executeJobNode()
    Engine->>Executor: execute(context)
    Executor->>Phase: merge-fi → setup → prechecks → work → commit → postchecks → merge-ri
    Phase->>Git: worktree ops, merges
    Engine->>Store: savePlanState()
    Engine->>UI: events (nodeTransition, planCompleted)
```

### Plan Lifecycle State Machine

```mermaid
stateDiagram-v2
    [*] --> scaffolding: scaffold()
    scaffolding --> scaffolding: addNode() / removeNode()
    scaffolding --> pending: finalize()
    pending --> running: resume()
    running --> running: node completes
    running --> paused: pause()
    paused --> running: resume()
    running --> succeeded: all jobs succeeded
    running --> partial: some failed, rest done
    partial --> running: retry failed jobs
    running --> canceled: cancel()
```

### Seven-Phase Execution Pipeline

```mermaid
graph LR
    MergeFI[Merge-FI] --> Setup
    Setup --> Prechecks
    Prechecks --> Work
    Work --> Commit
    Commit --> Postchecks
    Postchecks --> MergeRI[Merge-RI]

    style MergeFI fill:#e1f5fe
    style Setup fill:#e8f5e9
    style Prechecks fill:#fff3e0
    style Work fill:#fce4ec
    style Commit fill:#f3e5f5
    style Postchecks fill:#fff3e0
    style MergeRI fill:#e1f5fe
```

Each phase implements `IPhaseExecutor` with a uniform `PhaseContext → PhaseResult`
contract. The executor skips phases that aren't configured (e.g., no prechecks spec)
and supports resume-from-phase on retry.

### Three-Layer Storage Architecture

```mermaid
graph TB
    subgraph "Business Logic"
        Runner[PlanRunner]
        Engine[ExecutionEngine]
    end

    subgraph "Repository Layer"
        Repo[IPlanRepository<br/>DefaultPlanRepository]
        Def[IPlanDefinition<br/>FilePlanDefinition]
    end

    subgraph "Storage Layer"
        Store[IPlanRepositoryStore<br/>FileSystemPlanStore]
        FS[IFileSystem<br/>DefaultFileSystem]
    end

    Runner --> Repo
    Engine --> Repo
    Repo --> Def
    Repo --> Store
    Store --> FS

    style Repo fill:#e3f2fd
    style Store fill:#f1f8e9
```

- **IPlanRepository** — Lifecycle operations: scaffold, addNode, finalize, loadState, saveState
- **IPlanDefinition** — Lazy spec access: getWorkSpec(jobId), getPrechecksSpec(jobId)
- **IPlanRepositoryStore** — Raw filesystem: readPlanMetadata, writePlanMetadata, deleteplan

### DAG-Based Job Scheduling

```mermaid
graph TD
    subgraph "User Jobs"
        A[Job A<br/>root] --> C[Job C]
        B[Job B<br/>root] --> C
        C --> D[Job D]
        C --> E[Job E]
    end

    D --> SV[Snapshot<br/>Validation]
    E --> SV

    style SV fill:#fff9c4
    style A fill:#c8e6c9
    style B fill:#c8e6c9
```

SV node is auto-injected at scaffold time, auto-wired to depend on all user
leaf jobs. When new jobs are added, SV dependencies are recalculated automatically.
Jobs with all dependencies satisfied transition to `ready` and are scheduled
respecting `maxParallel`.

### DI Wiring (Composition Root)

```mermaid
graph LR
    subgraph "Interfaces"
        I1[ILogger]
        I2[IGitOperations]
        I3[IProcessSpawner]
        I4[IPlanRepository]
        I5[IFileSystem]
        I6[ICopilotRunner]
    end

    subgraph "Composition Root"
        CR[composition.ts]
    end

    subgraph "Concrete Implementations"
        C1[Logger]
        C2[DefaultGitOperations]
        C3[DefaultProcessSpawner]
        C4[DefaultPlanRepository]
        C5[DefaultFileSystem]
        C6[CopilotCliRunner]
    end

    CR --> I1 --> C1
    CR --> I2 --> C2
    CR --> I3 --> C3
    CR --> I4 --> C4
    CR --> I5 --> C5
    CR --> I6 --> C6
```

## When Designing a New Feature

Follow this sequence:

### Step 1: Draw the Component Diagram
Before writing code, create a Mermaid sequence diagram showing how the new
feature flows through existing components. Identify which existing interfaces
the feature will use and whether new interfaces are needed.

### Step 2: Define Interfaces First
Write the interface contract before the implementation. Place in
`src/interfaces/I<Name>.ts`. Include JSDoc with usage examples.

### Step 3: Identify the Adapter Boundary
If the feature requires a new external dependency (API, filesystem path, etc.),
create an adapter interface. Production implementation goes in `src/vscode/` or
beside the interface. Test mock uses `sinon.stub()`.

### Step 4: Implement with Injection
Implementation class accepts **only interfaces** in constructor. Use
`Logger.for()` for the component logger. Wrap all external calls in try/catch
with structured logging.

### Step 5: Register in Composition Root
Add to `src/composition.ts` using `container.registerSingleton()`. The class is
now resolvable by any consumer that declares the interface dependency.

### Step 6: Write Tests First (or Alongside)
Unit tests mock all dependencies via interfaces. Test the **contract** (what the
method promises), not the implementation (how it does it). See
`testing.instructions.md` for patterns.

### Step 7: Update Architecture Diagrams
Update this file's component diagrams and/or `docs/ARCHITECTURE.md` if the
feature adds a new component boundary, communication path, or storage layer.

## Architecture Review Checklist

When reviewing code changes, verify:

- [ ] **No framework leakage** — business logic imports no `vscode.*`, `fs.*`, or `child_process.*`
- [ ] **Composition over creation** — no `new ConcreteClass()` outside `composition.ts`
- [ ] **Interface defined** — new services have `src/interfaces/I<Name>.ts` + token
- [ ] **Single responsibility** — each class owns one concern
- [ ] **Adapter boundary** — new external deps wrapped in an interface
- [ ] **Structured logging** — `Logger.for()` with context objects on all operations
- [ ] **Error boundaries** — try/catch with logging on all external calls
- [ ] **Testable** — all dependencies injectable, no hidden global state
- [ ] **Diagrams updated** — component flow diagrams reflect the change
- [ ] **Phase contract** — new execution phases implement `IPhaseExecutor`
- [ ] **State persistence** — new state fields added to both in-memory and on-disk models
- [ ] **Event propagation** — state changes emit typed events for UI updates

## Diagram Maintenance

Architecture diagrams live in two places:
1. **This instruction file** — Component-level flow diagrams (updated when boundaries change)
2. **`docs/ARCHITECTURE.md`** — Detailed module documentation

When modifying diagrams:
- Keep them at **component level** — show interfaces and data flow, not method calls
- Use participant names matching the actual class/interface names in the codebase
- Color code by subsystem (blue=infrastructure, green=business, yellow=validation)
- Every new subsystem or communication path must appear in the sequence diagram
