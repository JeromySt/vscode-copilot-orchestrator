# Architecture

> Copilot Orchestrator — Parallel Copilot-driven development using DAG execution in isolated git worktrees.

## System Overview

Copilot Orchestrator is a VS Code extension that decomposes complex development tasks into a **Directed Acyclic Graph (DAG)** of work nodes, each executing in parallel within isolated git worktrees. It integrates with GitHub Copilot Chat via the **Model Context Protocol (MCP)** and provides real-time visual feedback through VS Code's UI.

```mermaid
graph TB
    subgraph "External"
        CHAT[Copilot Chat]
        CLI[Copilot CLI]
        REPO[Git Repository]
    end

    subgraph "VS Code Extension Host"
        subgraph "MCP Layer"
            IPC[IPC Server]
            STDIO[Stdio Child Process]
            HANDLER[McpHandler]
        end

        subgraph "Plan Engine"
            PR[PlanRunner]
            LC[PlanLifecycle]
            SM[StateMachine]
            SCH[Scheduler]
            PUMP[ExecutionPump]
            EX[JobExecutor]
        end

        subgraph "Storage"
            REPO_L[PlanRepository]
            STORE[PlanStore]
            DEF[PlanDefinition]
        end

        subgraph "Git Layer"
            GIT[GitOperations]
            WT[Worktrees]
            MRG[Merge]
            BR[Branches]
        end

        subgraph "UI Layer"
            PV[Plans Sidebar]
            SB[Status Bar]
            PDP[Plan Detail Panel]
            NDP[Node Detail Panel]
        end
    end

    CHAT -->|JSON-RPC stdio| STDIO
    STDIO -->|IPC + nonce auth| IPC
    IPC --> HANDLER
    HANDLER --> PR

    PR --> LC
    LC --> PUMP
    PUMP --> SCH
    SCH --> SM
    PUMP --> EX
    EX --> GIT
    EX --> CLI
    PR --> REPO_L
    REPO_L --> STORE
    REPO_L --> DEF

    GIT --> WT
    GIT --> MRG
    GIT --> BR
    WT --> REPO
    MRG --> REPO

    PR -.->|events| PV
    PR -.->|events| PDP
    PR -.->|events| NDP
    PR -.->|polling| SB
    PV -->|openPlan| PDP
    PDP -->|openNode| NDP
```

### Design Principles

| Principle | Implementation |
|-----------|----------------|
| **Isolation** | Each node executes in its own git worktree — no interference with the user's working directory |
| **Composability** | Plans are flat DAGs with visual grouping — no nested execution hierarchy |
| **Fault tolerance** | Failed nodes block only their dependents; retry resumes from the failed phase |
| **Extensibility** | DI interfaces (`INodeRunner`, `INodeExecutor`, `IGitOperations`) make every subsystem pluggable |
| **Observability** | Real-time UI updates via event emission on every state transition |
| **Security** | Agents sandboxed to their worktree; MCP bridge uses nonce authentication |

---

## Class Diagram — Core Domain

```mermaid
classDiagram
    class PlanRunner {
        -lifecycle: PlanLifecycle
        -persistence: PlanPersistence
        -events: PlanEventEmitter
        +enqueue(spec) PlanInstance
        +cancel(planId) void
        +get(planId) PlanInstance
        +registerPlan(plan) void
    }

    class PlanLifecycle {
        -pump: ExecutionPump
        -stateMachineFactory
        +register(plan) void
        +resume(planId) void
        +pause(planId) void
        +cancel(planId) void
    }

    class ExecutionPump {
        -scheduler: PlanScheduler
        -engine: JobExecutionEngine
        +pump() void
    }

    class PlanScheduler {
        +selectReady(plan) JobNode[]
    }

    class JobExecutionEngine {
        -executor: DefaultJobExecutor
        -git: IGitOperations
        +executeJobNode(plan, node) void
    }

    class DefaultJobExecutor {
        -spawner: IProcessSpawner
        -evidenceValidator: IEvidenceValidator
        -git: IGitOperations
        -copilotRunner: ICopilotRunner
        +execute(ctx) JobExecutionResult
    }

    class PlanStateMachine {
        -plan: PlanInstance
        +transition(nodeId, status) boolean
        +cancelAll() void
        +resetNodeToPending(nodeId) void
    }

    class PlanInstance {
        +id: string
        +spec: PlanSpec
        +jobs: Map
        +nodeStates: Map
        +roots: string[]
        +leaves: string[]
        +definition: IPlanDefinition
    }

    class JobNode {
        +id: string
        +producerId: string
        +name: string
        +dependencies: string[]
        +dependents: string[]
        +work: WorkSpec
    }

    PlanRunner --> PlanLifecycle
    PlanRunner --> PlanInstance
    PlanLifecycle --> ExecutionPump
    ExecutionPump --> PlanScheduler
    ExecutionPump --> JobExecutionEngine
    JobExecutionEngine --> DefaultJobExecutor
    PlanLifecycle --> PlanStateMachine
    PlanStateMachine --> PlanInstance
    PlanInstance --> JobNode
```

---

## Class Diagram — Storage Layer

```mermaid
classDiagram
    class IPlanRepository {
        <<interface>>
        +scaffold(spec) PlanInstance
        +addNode(planId, spec) PlanInstance
        +finalize(planId) PlanInstance
        +loadState(planId) PlanInstance
        +saveState(plan) void
        +getDefinition(planId) IPlanDefinition
    }

    class DefaultPlanRepository {
        -store: IPlanRepositoryStore
        -repoPath: string
    }

    class IPlanDefinition {
        <<interface>>
        +getWorkSpec(nodeId) WorkSpec
        +getPrechecksSpec(nodeId) WorkSpec
        +getPostchecksSpec(nodeId) WorkSpec
    }

    class FilePlanDefinition {
        -metadata: StoredPlanMetadata
        -store: IPlanRepositoryStore
    }

    class IPlanRepositoryStore {
        <<interface>>
        +readPlanMetadata(planId) StoredPlanMetadata
        +writePlanMetadata(metadata) void
        +writeNodeSpec(planId, nodeId, phase, spec) void
        +readNodeSpec(planId, nodeId, phase) WorkSpec
    }

    class FileSystemPlanStore {
        -fs: IFileSystem
        -basePath: string
    }

    IPlanRepository <|.. DefaultPlanRepository
    IPlanDefinition <|.. FilePlanDefinition
    IPlanRepositoryStore <|.. FileSystemPlanStore
    DefaultPlanRepository --> IPlanRepositoryStore
    DefaultPlanRepository --> FilePlanDefinition
    FilePlanDefinition --> IPlanRepositoryStore
```

---

## Class Diagram — DI & Adapters

```mermaid
classDiagram
    class ServiceContainer {
        -singletons: Map
        -factories: Map
        +registerSingleton(token, factory)
        +register(token, factory)
        +resolve(token) T
        +createScope() ServiceContainer
    }

    class IConfigProvider {
        <<interface>>
        +getConfig(section, key, default) T
    }
    class IDialogService {
        <<interface>>
        +showInfo(msg) void
        +showError(msg) void
        +showWarning(msg, opts) string
    }
    class IProcessSpawner {
        <<interface>>
        +spawn(cmd, args, opts) ChildProcess
    }
    class IGitOperations {
        <<interface>>
        +branches: IGitBranches
        +worktrees: IGitWorktrees
        +merge: IGitMerge
        +repository: IGitRepository
        +executor: IGitExecutor
    }

    class VsCodeConfigProvider
    class VsCodeDialogService
    class DefaultProcessSpawner
    class DefaultGitOperations

    IConfigProvider <|.. VsCodeConfigProvider
    IDialogService <|.. VsCodeDialogService
    IProcessSpawner <|.. DefaultProcessSpawner
    IGitOperations <|.. DefaultGitOperations

    ServiceContainer --> IConfigProvider
    ServiceContainer --> IDialogService
    ServiceContainer --> IProcessSpawner
    ServiceContainer --> IGitOperations
```

---

## Sequence Diagram — Plan Creation via MCP

```mermaid
sequenceDiagram
    participant Chat as Copilot Chat
    participant MCP as MCP Stdio Process
    participant IPC as IPC Bridge
    participant Handler as MCP Handler
    participant Validate as Ajv Validator
    participant Repo as PlanRepository
    participant Store as FileSystemPlanStore
    participant Runner as PlanRunner
    participant UI as Webview UI

    Chat->>MCP: JSON-RPC tools/call (create_copilot_plan)
    MCP->>IPC: Forward via named pipe
    IPC->>Handler: Route to createPlanHandler
    Handler->>Validate: validateInput(schema, args)
    Validate-->>Handler: valid: true
    Handler->>Repo: scaffold(spec)
    Repo->>Store: writePlanMetadata()
    Repo-->>Handler: PlanInstance (scaffolding)

    loop For each job
        Handler->>Repo: addNode(planId, jobSpec)
        Repo->>Store: writeNodeSpec(work)
        Repo-->>Handler: rebuilt PlanInstance
    end

    Handler->>Repo: finalize(planId)
    Repo->>Store: writePlanMetadata()
    Repo-->>Handler: finalized PlanInstance
    Handler->>Runner: registerPlan(plan)
    Runner->>UI: emit planCreated

    Handler-->>IPC: MCP response
    IPC-->>MCP: Forward response
    MCP-->>Chat: JSON-RPC response
```

---

## Sequence Diagram — Node Execution Pipeline

```mermaid
sequenceDiagram
    participant Pump as ExecutionPump
    participant Engine as ExecutionEngine
    participant Exec as JobExecutor
    participant Git as GitOperations
    participant CLI as Copilot CLI
    participant Store as PlanStore

    Pump->>Engine: executeJobNode(plan, node)
    Engine->>Git: createDetachedWorktree(commit)
    Git-->>Engine: worktreePath

    Note over Engine,Exec: Phase 1 — Merge-FI
    Engine->>Exec: execute(context)
    Exec->>Git: merge dependency commits into worktree

    Note over Engine,Exec: Phase 2 — Setup
    Exec->>Exec: write .gitignore, skill files

    Note over Engine,Exec: Phase 3 — Prechecks (optional)
    Exec->>CLI: run precheck command

    Note over Engine,Exec: Phase 4 — Work
    alt Agent Work
        Exec->>CLI: copilot -p instructions --add-dir worktree
        CLI-->>Exec: exit code + metrics
    else Shell Work
        Exec->>Exec: spawn shell command
    end

    Note over Engine,Exec: Phase 5 — Commit
    Exec->>Git: stage + commit changes
    Git-->>Exec: completedCommit SHA

    Note over Engine,Exec: Phase 6 — Postchecks (optional)
    Exec->>CLI: run postcheck command

    Note over Engine,Exec: Phase 7 — Merge-RI (leaf nodes)
    Exec->>Git: merge-tree --write-tree (in-memory)
    Git-->>Exec: new commit on snapshot branch

    Exec-->>Engine: JobExecutionResult
    Engine->>Store: saveState(plan)
    Engine-->>Pump: node completed
```

---

## Sequence Diagram — Snapshot Validation & Final Merge

```mermaid
sequenceDiagram
    participant Pump as ExecutionPump
    participant SV as Snapshot Validation Node
    participant Git as GitOperations
    participant Target as Target Branch

    Note over Pump: All leaf nodes merged to snapshot branch

    Pump->>SV: execute (worktree = snapshot worktree)

    Note over SV: Prechecks — target branch health
    SV->>Git: check targetBranch dirty/ahead
    alt Target is dirty
        SV-->>Pump: force-fail (user must resolve)
    else Target advanced
        SV->>Git: rebase snapshot onto target
    end

    Note over SV: Work — run verifyRiSpec
    SV->>SV: npm run compile && npm run test:unit

    Note over SV: Merge-RI — final merge to target
    SV->>Git: merge-tree snapshot to target
    Git->>Target: update branch ref
    Git-->>SV: success

    SV-->>Pump: succeeded
    Note over Pump: Clean up snapshot worktree + branch
```

---

## Sequence Diagram — PR Lifecycle Management

```mermaid
sequenceDiagram
    participant Chat as Copilot Chat
    participant MCP as MCP Handler
    participant PRMgr as PRLifecycleManager
    participant Store as ManagedPRStore
    participant Remote as RemotePRService
    participant Monitor as ReleasePRMonitor
    participant Agent as Copilot Agent

    Note over Chat,Agent: PR Discovery & Adoption

    Chat->>MCP: list_available_prs(repoPath, baseBranch)
    MCP->>PRMgr: listAvailablePRs(options)
    PRMgr->>Remote: getPRs(filters)
    Remote-->>PRMgr: [PR #42, PR #38, ...]
    PRMgr->>Store: loadAll()
    Store-->>PRMgr: [managedPR records]
    PRMgr-->>MCP: [{prNumber, title, isManaged, ...}]
    MCP-->>Chat: PRs with managed status

    Chat->>MCP: adopt_pr(prNumber: 42, priority: 1)
    MCP->>PRMgr: adoptPR(options)
    PRMgr->>Remote: getPR(42)
    Remote-->>PRMgr: PR metadata
    PRMgr->>PRMgr: create ManagedPR (status: adopted)
    PRMgr->>Store: save(managedPR)
    PRMgr-->>MCP: {success: true, managedPR}
    MCP-->>Chat: PR adopted

    Note over Chat,Agent: Monitoring Lifecycle

    Chat->>MCP: start_pr_monitoring(id)
    MCP->>PRMgr: startMonitoring(id)
    PRMgr->>PRMgr: transition adopted → monitoring
    PRMgr->>Monitor: registerPR(managedPR)
    Monitor->>Monitor: start 40-min monitoring cycle
    PRMgr-->>MCP: {success: true}

    loop Every 2 minutes for 40 minutes
        Monitor->>Remote: checkCI()
        Remote-->>Monitor: check status
        Monitor->>Remote: getComments()
        Remote-->>Monitor: unresolved threads
        Monitor->>Remote: getSecurityAlerts()
        Remote-->>Monitor: vulnerabilities

        alt Issues detected
            Monitor->>PRMgr: transition monitoring → addressing
            Monitor->>Agent: spawn fix agent (failure context)
            Agent->>Agent: fix issue + commit + push
            Agent-->>Monitor: fix completed
            Monitor->>PRMgr: transition addressing → monitoring
        else All clear
            Monitor->>PRMgr: update (ready or blocked)
        end
    end

    Note over Chat,Agent: Priority & Lifecycle Management

    Chat->>MCP: promote_pr(id)
    MCP->>PRMgr: promotePR(id)
    PRMgr->>PRMgr: increment priority tier
    PRMgr->>Store: save(managedPR)
    PRMgr-->>MCP: {success: true}

    Chat->>MCP: abandon_pr(id)
    MCP->>PRMgr: abandonPR(id)
    PRMgr->>Monitor: unregisterPR(id)
    PRMgr->>PRMgr: transition → abandoned
    PRMgr->>Store: save(managedPR)
    PRMgr-->>MCP: {success: true}
```

---

## State Machine — PR Lifecycle

```mermaid
stateDiagram-v2
    [*] --> adopted: adopt_pr()

    adopted --> monitoring: start_pr_monitoring()
    adopted --> abandoned: abandon_pr()
    adopted --> [*]: remove_pr()

    monitoring --> addressing: Issues detected\n(CI fail, comments, alerts)
    monitoring --> ready: All checks passed
    monitoring --> blocked: Failing checks\nor unresolved feedback
    monitoring --> adopted: stop_pr_monitoring()
    monitoring --> abandoned: abandon_pr()

    addressing --> monitoring: Fixes applied
    addressing --> blocked: Fix failed
    addressing --> abandoned: abandon_pr()

    ready --> monitoring: New feedback\ndetected
    ready --> abandoned: abandon_pr()
    ready --> [*]: remove_pr()

    blocked --> monitoring: Manual intervention\nor retry
    blocked --> addressing: Auto-fix retry
    blocked --> abandoned: abandon_pr()

    abandoned --> [*]: remove_pr()

    note right of adopted
        PR taken ownership
        Not yet monitored
    end note

    note right of monitoring
        40-min autonomous cycles
        Check CI, comments, alerts
        Every 2 minutes
    end note

    note right of addressing
        Copilot agents spawned
        Fixing failures
        Replying to comments
    end note

    note right of ready
        All checks passed
        Ready to merge
    end note

    note right of blocked
        Failing checks or
        Unresolved feedback
    end note

    note right of abandoned
        Management stopped
        PR record preserved
    end note
```

---

## Component Dependency Map

```mermaid
graph LR
    subgraph "Entry"
        EXT[extension.ts]
        COMP[composition.ts]
    end

    subgraph "Orchestration"
        PR[PlanRunner]
        LC[PlanLifecycle]
        PUMP[ExecutionPump]
        SM[StateMachine]
        SCH[Scheduler]
        ENG[ExecutionEngine]
        EXEC[JobExecutor]
    end

    subgraph "MCP"
        MGR[McpServerManager]
        HAND[McpHandler]
        TOOLS[ToolDefinitions]
        VAL[SchemaValidation]
    end

    subgraph "Storage"
        REPO[PlanRepository]
        STORE[PlanStore]
        PERS[Persistence]
    end

    subgraph "Git"
        GITOPS[GitOperations]
        WT[Worktrees]
        MRG[Merge]
        BR[Branches]
    end

    subgraph "Agent"
        DELEG[AgentDelegator]
        COPRUN[CopilotCliRunner]
        DISC[ModelDiscovery]
    end

    subgraph "Infrastructure"
        LOG[Logger]
        CONT[ServiceContainer]
        GLOB[GlobalCapacity]
        PWR[PowerManager]
        PULSE[PulseEmitter]
    end

    EXT --> COMP
    COMP --> CONT

    PR --> LC
    PR --> PERS
    LC --> PUMP
    PUMP --> SCH
    PUMP --> ENG
    SCH --> SM
    ENG --> EXEC

    EXEC --> GITOPS
    EXEC --> COPRUN
    EXEC --> DELEG

    HAND --> PR
    HAND --> REPO
    HAND --> VAL
    MGR --> HAND

    REPO --> STORE
    GITOPS --> WT
    GITOPS --> MRG
    GITOPS --> BR

    COPRUN --> DISC
```

---

## Module Layout

```
src/
├── extension.ts              # Extension activation and lifecycle
├── composition.ts            # Production DI composition root
├── agent/                    # Copilot CLI delegation
│   ├── agentDelegator.ts     #   Agent orchestration and prompt building
│   ├── copilotCliRunner.ts   #   CLI invocation wrapper
│   ├── copilotStatsParser.ts #   Usage metrics extraction
│   ├── modelDiscovery.ts     #   Dynamic model enumeration
│   └── cliCheck*.ts          #   CLI availability detection
├── commands/                 # VS Code command registrations
├── core/                     # Core infrastructure
│   ├── container.ts          #   Symbol-based DI container
│   ├── tokens.ts             #   23 service registration tokens
│   ├── logger.ts             #   Structured logging (Logger.for())
│   ├── globalCapacity.ts     #   Cross-instance job coordination
│   ├── powerManager.ts       #   Sleep prevention during execution
│   ├── pulse.ts              #   UI heartbeat timer
│   └── orphanedWorktreeCleanup.ts
├── git/                      # Git operations
│   ├── DefaultGitOperations.ts  # IGitOperations facade
│   ├── orchestrator.ts       #   High-level git workflows
│   └── core/                 #   Low-level git commands
│       ├── branches.ts       #     Branch CRUD
│       ├── executor.ts       #     Async git command execution
│       ├── merge.ts          #     In-memory merge-tree operations
│       └── worktrees.ts      #     Worktree CRUD with per-repo mutex
├── interfaces/               # 18 DI interface files (one per interface)
├── mcp/                      # Model Context Protocol integration
│   ├── handler.ts            #   Tool dispatch router
│   ├── handlers/             #   Business logic per tool
│   │   ├── plan/             #     scaffold, addJob, finalize, reshape, update
│   │   ├── planHandlers.ts   #     Plan CRUD, status, cancel, retry
│   │   └── jobHandlers.ts    #     Job-centric API
│   ├── tools/                #   JSON Schema tool definitions
│   ├── validation/           #   Ajv schema validation
│   ├── ipc/                  #   Named-pipe IPC bridge
│   └── stdio/                #   Stdio transport for MCP child process
├── plan/                     # DAG execution engine
│   ├── runner.ts             #   PlanRunner — top-level orchestrator
│   ├── planLifecycle.ts      #   Start, pause, resume, cancel
│   ├── executionPump.ts      #   Main scheduling loop
│   ├── executionEngine.ts    #   Per-node 7-phase execution
│   ├── executor.ts           #   DefaultJobExecutor (work routing)
│   ├── stateMachine.ts       #   DAG state transitions & propagation
│   ├── scheduler.ts          #   Capacity-aware node selection
│   ├── builder.ts            #   PlanSpec → PlanInstance DAG builder
│   ├── phases/               #   Individual phase implementations
│   │   ├── mergeFiPhase.ts   #     Forward Integration merge
│   │   ├── setupPhase.ts     #     Worktree environment prep
│   │   ├── precheckPhase.ts  #     Pre-execution validation
│   │   ├── workPhase.ts      #     Agent/shell/process execution
│   │   ├── commitPhase.ts    #     Stage + commit changes
│   │   ├── postcheckPhase.ts #     Post-execution validation
│   │   └── mergeRiPhase.ts   #     Reverse Integration (in-memory)
│   ├── repository/           #   Plan persistence layer
│   └── store/                #   Filesystem storage backend
├── process/                  # OS process monitoring (CPU/memory)
├── types/                    # Shared configuration types
├── ui/                       # VS Code UI components
│   ├── plansViewProvider.ts  #   Sidebar webview
│   ├── statusBar.ts          #   Status bar item
│   ├── panels/               #   Webview panels + controllers
│   ├── templates/            #   HTML/CSS/JS template generators
│   └── webview/              #   Browser-bundled control framework
│       ├── eventBus.ts       #     Pub/sub event bus
│       ├── subscribableControl.ts  # Base control class
│       ├── controls/         #     15 reusable webview controls
│       └── entries/          #     esbuild browser entry points
└── vscode/                   # VS Code API adapters
    └── adapters.ts           #   Production implementations
```

---

## Node State Machine

```mermaid
stateDiagram-v2
    [*] --> pending
    pending --> ready : All dependencies succeeded
    pending --> blocked : A dependency failed
    pending --> canceled : Plan canceled

    ready --> scheduled : Selected by scheduler
    ready --> blocked : Dependency failed (race)
    ready --> canceled : Plan canceled

    scheduled --> running : Executor started
    scheduled --> failed : Startup error
    scheduled --> canceled : Plan canceled

    running --> succeeded : All phases passed
    running --> failed : Phase error
    running --> canceled : Plan canceled

    failed --> pending : retryNode()
    blocked --> pending : Upstream retried and succeeded

    succeeded --> [*]
    canceled --> [*]
```

**DAG propagation rules:**
- **On success** → Check all dependents; if all their dependencies succeeded, transition to `ready`
- **On failure** → BFS propagation of `blocked` to all downstream nodes
- **On retry** → `resetNodeToPending()` resets the node and unblocks descendants

---

## 7-Phase Execution Pipeline

```mermaid
graph LR
    MFI[Merge-FI] --> SETUP[Setup]
    SETUP --> PRE[Prechecks]
    PRE --> WORK[Work]
    WORK --> COMMIT[Commit]
    COMMIT --> POST[Postchecks]
    POST --> MRI[Merge-RI]

    style MFI fill:#e1f5fe
    style SETUP fill:#e8f5e9
    style PRE fill:#fff3e0
    style WORK fill:#fce4ec
    style COMMIT fill:#f3e5f5
    style POST fill:#fff3e0
    style MRI fill:#e1f5fe
```

| Phase | Purpose | Skippable |
|-------|---------|-----------|
| **Merge-FI** | Forward-integrate dependency commits into worktree | Never (idempotent) |
| **Setup** | Prepare worktree (.gitignore, skill files, symlinks) | On resume |
| **Prechecks** | Optional validation before work (build, lint) | If not specified |
| **Work** | Execute the actual task (agent/shell/process) | If not specified |
| **Commit** | Stage and commit file changes | On resume |
| **Postchecks** | Optional validation after work (tests) | If not specified |
| **Merge-RI** | In-memory merge to snapshot/target branch (leaf nodes only) | Non-leaf nodes |

On retry, the executor resumes from the failed phase using `resumeFromPhase`, skipping completed phases.

---

## Three-Layer Storage Architecture

```mermaid
graph TB
    subgraph "Business Logic"
        Runner[PlanRunner]
        Engine[ExecutionEngine]
    end

    subgraph "Repository Layer"
        Repo["IPlanRepository<br/>(DefaultPlanRepository)"]
        Def["IPlanDefinition<br/>(FilePlanDefinition)"]
    end

    subgraph "Storage Layer"
        Store["IPlanRepositoryStore<br/>(FileSystemPlanStore)"]
        FS["IFileSystem<br/>(DefaultFileSystem)"]
    end

    Runner --> Repo
    Engine --> Repo
    Repo --> Def
    Repo --> Store
    Store --> FS

    style Repo fill:#e3f2fd
    style Store fill:#f1f8e9
```

**Filesystem layout:**

```
.orchestrator/plans/<plan-id>/
├── plan.json                      # Topology + execution state
└── specs/<node-id>/
    ├── current/                   # Active specifications
    │   ├── work.json              # Work spec (type, model)
    │   └── work_instructions.md   # Agent instructions (lazy-loaded)
    └── attempts/<n>/              # Per-attempt snapshots
```

---

## MCP Transport Architecture

```mermaid
graph LR
    subgraph "Copilot Chat"
        CHAT[Chat UI]
    end

    subgraph "MCP Stdio Child"
        STDIO[StdioTransport]
    end

    subgraph "Extension Host"
        IPC_S[IPC Server]
        ROUTE[McpHandler]
        PLAN[PlanRunner]
    end

    CHAT -->|JSON-RPC stdin/stdout| STDIO
    STDIO -->|Named pipe + nonce| IPC_S
    IPC_S --> ROUTE
    ROUTE --> PLAN
```

**26 MCP tools** across three APIs:

| API | Tools | Examples |
|-----|-------|----------|
| **Plan-based** | 15 | `create_copilot_plan`, `scaffold_copilot_plan`, `add_copilot_plan_job`, `finalize_copilot_plan`, `get_copilot_plan_status`, `retry_copilot_plan`, `reshape_copilot_plan` |
| **Job-centric** | 6 | `get_copilot_job`, `list_copilot_jobs`, `retry_copilot_job`, `force_fail_copilot_job`, `update_copilot_plan_job` |
| **Release Management** | 5 | `create_copilot_release`, `start_copilot_release`, `get_copilot_release_status`, `cancel_copilot_release`, `list_copilot_releases` |

---

## DI Token Registry (31 tokens)

| Token | Interface | Concrete Class | Lifetime |
|-------|-----------|---------------|----------|
| `IConfigProvider` | `IConfigProvider` | `VsCodeConfigProvider` | Singleton |
| `IDialogService` | `IDialogService` | `VsCodeDialogService` | Singleton |
| `IClipboardService` | `IClipboardService` | `VsCodeClipboardService` | Singleton |
| `IGitOperations` | `IGitOperations` | `DefaultGitOperations` | Singleton |
| `IProcessSpawner` | `IProcessSpawner` | `DefaultProcessSpawner` | Singleton |
| `IProcessMonitor` | `IProcessMonitor` | `ProcessMonitor` | Singleton |
| `IPulseEmitter` | `IPulseEmitter` | `PulseEmitter` | Singleton |
| `ILogger` | `ILogger` | `Logger` | Singleton |
| `IEnvironment` | `IEnvironment` | `DefaultEnvironment` | Singleton |
| `ICopilotRunner` | `ICopilotRunner` | `CopilotCliRunner` | Singleton |
| `INodeExecutor` | `INodeExecutor` | `DefaultJobExecutor` | Singleton |
| `INodeStateMachine` | `INodeStateMachine` | _(scoped per plan)_ | Transient |
| `INodePersistence` | `INodePersistence` | `PlanPersistence` | Singleton |
| `IEvidenceValidator` | `IEvidenceValidator` | `DefaultEvidenceValidator` | Singleton |
| `IFileSystem` | `IFileSystem` | `DefaultFileSystem` | Singleton |
| `IMcpRequestRouter` | `IMcpRequestRouter` | _(scoped per request)_ | Transient |
| `IMcpManager` | `IMcpManager` | `StdioMcpServerManager` | Singleton |
| `IGlobalCapacity` | `IGlobalCapacity` | `GlobalCapacityManager` | Singleton |
| `IPlanConfigManager` | `IPlanConfigManager` | `PlanConfigManager` | Singleton |
| `IPlanRepositoryStore` | `IPlanRepositoryStore` | `FileSystemPlanStore` | Singleton |
| `IPlanRepository` | `IPlanRepository` | `DefaultPlanRepository` | Singleton |
| `IAgentDelegator` | _(internal)_ | `AgentDelegator` | Singleton |
| `INodeRunner` | `INodeRunner` | _(composed)_ | Singleton |
| `IReleaseManager` | `IReleaseManager` | `DefaultReleaseManager` | Singleton |
| `IReleasePRMonitor` | `IReleasePRMonitor` | `DefaultReleasePRMonitor` | Singleton |
| `IIsolatedRepoManager` | `IIsolatedRepoManager` | `DefaultIsolatedRepoManager` | Singleton |
| `IReleaseStore` | `IReleaseStore` | `FileSystemReleaseStore` | Singleton |
| `IRemotePRService` | `IRemotePRService` | `GitHubPRService` / `AdoPRService` | Transient |
| `IRemoteProviderDetector` | `IRemoteProviderDetector` | `DefaultRemoteProviderDetector` | Singleton |
| `IRemotePRServiceFactory` | `IRemotePRServiceFactory` | `DefaultRemotePRServiceFactory` | Singleton |
| `IReleaseConfigManager` | `IReleaseConfigManager` | `DefaultReleaseConfigManager` | Singleton |

---

## Security Model

### Agent Sandbox

```mermaid
graph TB
    subgraph "Allowed"
        WT[Job Worktree Directory]
        AF[Explicit allowedFolders]
        AU[Explicit allowedUrls]
    end

    subgraph "Blocked"
        ROOT[Repository Root]
        SYS[System Files]
        NET[Unauthorized Network]
        OTHER[Other Worktrees]
    end

    CLI[Copilot CLI] -->|--add-dir| WT
    CLI -->|--add-dir| AF
    CLI -->|--allow-url| AU
    CLI -.->|blocked| ROOT
    CLI -.->|blocked| SYS
    CLI -.->|blocked| NET
    CLI -.->|blocked| OTHER
```

### MCP Authentication

The stdio child process authenticates to the extension host via a nonce:
1. Extension generates random nonce, passes via `MCP_AUTH_NONCE` env var
2. Child presents nonce in IPC handshake
3. Mismatch = connection rejected

### Global Capacity Coordination

Multi-instance coordination via `capacity-registry.json` at the global storage path:
- Instances register on activation, deregister on deactivation
- Heartbeat every 5 seconds; stale instances (>30s) pruned
- Scheduling checks global running count before dispatching work

---

## Release Architecture

The release system combines multiple plan commits into a single pull request with autonomous monitoring and feedback resolution, supporting GitHub, GitHub Enterprise, and Azure DevOps.

### Release Pipeline Flow

```mermaid
sequenceDiagram
    participant User
    participant UI as Release Wizard Panel
    participant RM as ReleaseManager
    participant IRM as IsolatedRepoManager
    participant Git as GitOperations
    participant Factory as RemotePRServiceFactory
    participant Detector as RemoteProviderDetector
    participant Service as GitHubPRService/AdoPRService
    participant Monitor as ReleasePRMonitor

    User->>UI: Create Release
    UI->>RM: createRelease(options)
    RM->>IRM: createIsolatedRepo(releaseId, repoPath, branch)
    IRM->>Git: clone --shared (or --reference fallback)
    Git-->>IRM: isolatedRepoPath
    IRM-->>RM: IsolatedRepoInfo
    RM->>RM: Store release metadata
    RM-->>UI: ReleaseDefinition

    User->>UI: Start Release
    UI->>RM: startRelease(releaseId)
    
    Note over RM: Status: merging
    RM->>Git: Merge all plan commits
    
    Note over RM: Status: creating-pr
    RM->>Factory: getServiceForRepo(isolatedRepoPath)
    Factory->>Detector: detect(isolatedRepoPath)
    Detector->>Git: git config --get remote.origin.url
    Git-->>Detector: https://github.com/owner/repo.git
    Detector-->>Factory: RemoteProviderInfo(type: 'github')
    Factory-->>RM: GitHubPRService
    
    RM->>Service: acquireCredentials(providerInfo)
    Service->>Service: gh auth token → git credential fill → $GITHUB_TOKEN
    Service-->>RM: RemoteCredentials
    
    RM->>Service: createPR(options)
    Service->>Service: gh pr create (or az repos pr create)
    Service-->>RM: PRCreateResult(prNumber, prUrl)
    
    Note over RM: Status: monitoring
    RM->>Monitor: startMonitoring(releaseId, prNumber, 40min)
    
    loop Every 2 minutes
        Monitor->>Service: getPRChecks(prNumber)
        Monitor->>Service: getPRComments(prNumber)
        Monitor->>Service: getSecurityAlerts(branch)
        
        alt CI failures or unresolved comments
            Note over Monitor: Status: addressing
            Monitor->>Monitor: Spawn Copilot agent to fix issues
            Monitor->>Service: replyToComment() / resolveThread()
        end
    end
    
    Monitor-->>RM: PR merged (or timeout)
    Note over RM: Status: succeeded
    RM-->>UI: Release completed
```

### Provider Detection and Credential Chain

```mermaid
graph TB
    subgraph "Provider Detection"
        URL[git remote URL]
        Parse[URL Parser]
        Type{Provider Type}
    end
    
    subgraph "Credential Acquisition"
        GH_CLI[gh auth token]
        AZ_CLI[az account get-access-token]
        GIT_CRED[git credential fill]
        ENV_GH[GITHUB_TOKEN env var]
        ENV_ADO[AZURE_DEVOPS_TOKEN env var]
    end
    
    URL --> Parse
    Parse --> Type
    
    Type -->|github.com| GH{GitHub}
    Type -->|custom hostname| GHE{GitHub Enterprise}
    Type -->|dev.azure.com| ADO{Azure DevOps}
    
    GH --> GH_CLI
    GH_CLI -->|fallback| GIT_CRED
    GIT_CRED -->|fallback| ENV_GH
    
    GHE --> GH_CLI
    
    ADO --> AZ_CLI
    AZ_CLI -->|fallback| GIT_CRED
    GIT_CRED -->|fallback| ENV_ADO
    
    style GH fill:#e3f2fd
    style GHE fill:#e3f2fd
    style ADO fill:#fff3e0
```

### Isolated Repository Architecture

Releases execute in isolated git clones under `.orchestrator/release/<sanitized-branch>/`:

```mermaid
graph TB
    subgraph "Main Repository"
        MainRepo[Repository Root]
        MainGit[.git/]
    end
    
    subgraph "Isolated Clones (.orchestrator/release/)"
        Clone1[release-v1.2.0/]
        Clone2[hotfix-auth/]
        Clone3[feature-bundle/]
        
        C1Git[.git/ (shared objects)]
        C2Git[.git/ (shared objects)]
        C3Git[.git/ (shared objects)]
    end
    
    MainRepo --> MainGit
    MainGit -.->|git clone --shared| C1Git
    MainGit -.->|git clone --shared| C2Git
    MainGit -.->|git clone --shared| C3Git
    
    Clone1 --> C1Git
    Clone2 --> C2Git
    Clone3 --> C3Git
    
    style Clone1 fill:#c8e6c9
    style Clone2 fill:#fff9c4
    style Clone3 fill:#e1f5fe
```

**Key benefits:**
- **Concurrent releases** — Multiple releases can run in parallel without conflicts
- **Shared objects** — Uses `--shared` or `--reference` to avoid duplicating repository objects
- **Persistent state** — Release artifacts remain after completion for debugging
- **Safe cleanup** — Isolated clones can be removed without affecting the main repository

### Storage Layout

```
.orchestrator/
└── release/
    ├── release-v1.2.0/                 # Isolated clone for release/v1.2.0
    │   ├── .git/                       # Shared with main repo via --shared
    │   ├── release-state.json          # Release metadata and status
    │   └── <source files>              # Full working tree with merged commits
    ├── hotfix-auth/                    # Another concurrent release
    │   ├── .git/
    │   ├── release-state.json
    │   └── <source files>
    └── feature-bundle/
        ├── .git/
        ├── release-state.json
        └── <source files>
```

---

## Related Documentation

| Document | Focus |
|----------|-------|
| [DI Guide](DI_GUIDE.md) | DI patterns, adding services, mocking |
| [Testing Guide](TESTING.md) | Test framework, patterns, coverage |
| [Copilot Integration](COPILOT_INTEGRATION.md) | MCP tools, agent delegation |
| [Groups](GROUPS.md) | Visual hierarchy, namespace isolation |
| [Worktrees & Merging](WORKTREES_AND_MERGING.md) | Git isolation, merge strategies |
| [Releases](RELEASES.md) | Release management, multi-provider PR support, monitoring |
| [Contributing](CONTRIBUTING.md) | Setup, workflow, PR process |
