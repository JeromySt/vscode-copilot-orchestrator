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

**21 MCP tools** across two APIs:

| API | Tools | Examples |
|-----|-------|----------|
| **Plan-based** | 15 | `create_copilot_plan`, `scaffold_copilot_plan`, `add_copilot_plan_job`, `finalize_copilot_plan`, `get_copilot_plan_status`, `retry_copilot_plan`, `reshape_copilot_plan` |
| **Job-centric** | 6 | `get_copilot_job`, `list_copilot_jobs`, `retry_copilot_job`, `force_fail_copilot_job`, `update_copilot_plan_job` |

---

## DI Token Registry (23 tokens)

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

## Related Documentation

| Document | Focus |
|----------|-------|
| [DI Guide](DI_GUIDE.md) | DI patterns, adding services, mocking |
| [Testing Guide](TESTING.md) | Test framework, patterns, coverage |
| [Copilot Integration](COPILOT_INTEGRATION.md) | MCP tools, agent delegation |
| [Groups](GROUPS.md) | Visual hierarchy, namespace isolation |
| [Worktrees & Merging](WORKTREES_AND_MERGING.md) | Git isolation, merge strategies |
| [Contributing](CONTRIBUTING.md) | Setup, workflow, PR process |
