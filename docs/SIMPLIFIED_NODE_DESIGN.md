# Simplified Node Design

> **Status:** Proposal  
> **Date:** 2026-02-07  
> **Scope:** Plan/Node type system, MCP API, PlanRunner internals

## 1. Problem Statement

The current architecture maintains a hard distinction between **Plans** and **Nodes**:

- A `PlanSpec` defines an execution topology (name, branches, parallelism, jobs, subPlans).
- A `PlanInstance` holds the DAG of `PlanNode`s plus per-node `NodeExecutionState`.
- `SubPlanNode` creates a _child_ `PlanInstance` at runtime, adding nesting complexity.
- The MCP API exposes separate `create_copilot_plan` (multi-job DAG) and `create_copilot_job` (single job wrapped in a plan) tools.

This creates friction:

1. **Conceptual overhead** — users must reason about "plans containing nodes" when often they just want to run work units with dependencies.
2. **Rigid hierarchy** — sub-plans create nested `PlanInstance` trees; grouping is only possible through this mechanism.
3. **API surface duplication** — `create_copilot_job` is a thin wrapper that hides plan creation, but querying still requires plan IDs.
4. **Internal complexity** — `PlanRunner` manages `Map<planId, PlanInstance>` and `Map<planId, PlanStateMachine>` with parent/child linking for sub-plans.

## 2. Design Goals

| # | Goal | Rationale |
|---|------|-----------|
| G1 | **Plan is a grouping attribute on nodes** | Nodes are first-class; plans are an optional label for grouping |
| G2 | **Nodes can exist independently** | A node with no `group` is a standalone work unit |
| G3 | **Simplified MCP API** | Fewer tools; a single `create_copilot_node` replaces both plan and job creation |
| G4 | **Backward compatibility** | Existing `create_copilot_plan` callers continue to work via adapter layer |
| G5 | **Preserve DAG execution semantics** | Dependencies, parallel scheduling, FI/RI merges remain unchanged |
| G6 | **Clean DI boundaries** | Interfaces for runner, executor, and registry enable testing |

## 3. Current Architecture (Summary)

```
┌────────────────────────────────────────────────────────┐
│ PlanSpec (user input)                                  │
│   name, baseBranch, targetBranch, maxParallel          │
│   jobs: JobNodeSpec[]                                  │
│   subPlans?: SubPlanNodeSpec[]                         │
└──────────────────┬─────────────────────────────────────┘
                   │ buildPlan()
                   ▼
┌────────────────────────────────────────────────────────┐
│ PlanInstance (runtime)                                  │
│   id, spec, nodes: Map<id, PlanNode>                   │
│   nodeStates: Map<id, NodeExecutionState>              │
│   roots[], leaves[], producerIdToNodeId                │
│   parentPlanId?, parentNodeId?  ← sub-plan linking     │
└──────────────────┬─────────────────────────────────────┘
                   │
       ┌───────────┴───────────┐
       ▼                       ▼
   JobNode                 SubPlanNode
   (type: 'job')           (type: 'subPlan')
   task, work,             childSpec: PlanSpec
   prechecks,              childPlanId? → nested PlanInstance
   postchecks
```

**Key relationships:**
- `PlanRunner` owns `Map<planId, PlanInstance>` and `Map<planId, PlanStateMachine>`.
- `SubPlanNode` spawns a child `PlanInstance` at runtime (recursive nesting).
- `PlanStateMachine` drives transitions per node within a single `PlanInstance`.
- `JobExecutor` (DI'd via `setExecutor()`) executes individual `JobNode` work.

## 4. Proposed Architecture

### 4.1 Core Concept: Node-Centric Model

**Plan becomes a grouping attribute.** Instead of `PlanInstance` containing nodes, we have a flat `NodeRegistry` where each node carries an optional `group` (formerly "plan") identifier.

```
┌──────────────────────────────────────────────────────────┐
│ NodeSpec (user input — replaces JobNodeSpec + PlanSpec)   │
│   producerId, name, task                                 │
│   work?, prechecks?, postchecks?, instructions?          │
│   dependencies: string[]                                 │
│   group?: { name, baseBranch?, targetBranch?,            │
│             maxParallel?, cleanUpSuccessfulWork? }        │
│   baseBranch?                                            │
└──────────────────────────────────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────────────┐
│ NodeInstance (runtime — replaces PlanNode + state)        │
│   id (UUID), producerId, name, type: 'job'               │
│   task, work?, prechecks?, postchecks?                   │
│   dependencies: string[]  (resolved UUIDs)               │
│   dependents: string[]    (computed)                     │
│   group?: GroupInfo                                       │
│   state: NodeExecutionState                              │
│   repoPath, baseBranch, worktreePath?                    │
└──────────────────────────────────────────────────────────┘
```

### 4.2 Grouping

```typescript
/**
 * Grouping replaces PlanInstance as the organizational unit.
 * Nodes sharing the same group.id are scheduled together
 * and share branch/merge semantics.
 */
interface GroupInfo {
  /** Group ID (auto-generated UUID) */
  id: string;

  /** Human-readable name */
  name: string;

  /** Base branch for all nodes in this group */
  baseBranch: string;

  /** Target branch to merge leaf nodes into */
  targetBranch?: string;

  /** Max parallel nodes in this group */
  maxParallel: number;

  /** Whether to clean up worktrees after merge */
  cleanUpSuccessfulWork: boolean;

  /** Worktree root directory */
  worktreeRoot: string;

  /** Timestamps */
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
}
```

- **Grouped nodes** share a `group.id` → the runtime groups them for DAG analysis, scheduling limits, and merge targets.
- **Ungrouped nodes** (`group` is `undefined`) operate independently — each is its own scheduling unit with its own worktree/branch context.
- **The current `PlanSpec.subPlans`** becomes a convenience for creating nested groups; the `SubPlanNode` type is eliminated in favor of just creating more nodes with a sub-group ID.

### 4.3 Eliminating SubPlanNode

`SubPlanNode` exists only to nest a `PlanSpec` inside another plan. With the group model:

| Current (SubPlanNode) | Proposed (Group attribute) |
|---|---|
| `SubPlanNode.childSpec: PlanSpec` creates a nested `PlanInstance` | Jobs inside the sub-plan become regular nodes with a **sub-group** (child group ID) |
| Parent plan waits for sub-plan to finish | Parent nodes depend on leaf nodes of the sub-group (explicit dependencies) |
| Separate `PlanStateMachine` per nested plan | Single `NodeStateMachine` manages all nodes; group-scoped status is derived |

**Sub-group linking:**

```typescript
interface GroupInfo {
  // ... fields above ...

  /** Parent group ID (for sub-groups replacing SubPlanNode) */
  parentGroupId?: string;
}
```

The builder flattens sub-plans into the same node registry, assigning each sub-plan a child `GroupInfo` linked to the parent via `parentGroupId`.

## 5. New Type Definitions

### 5.1 NodeSpec (User Input — replaces JobNodeSpec + PlanSpec combination)

```typescript
/**
 * Specification for creating a node (user input).
 * Replaces both JobNodeSpec (for individual nodes) and 
 * PlanSpec (when used with group).
 */
interface NodeSpec {
  /** User-controlled identifier for dependency references */
  producerId: string;

  /** Human-friendly display name (defaults to producerId) */
  name?: string;

  /** Task description (what this node does) */
  task: string;

  /** Work to perform (shell command, process, or agent) */
  work?: WorkSpec;

  /** Validation before work */
  prechecks?: WorkSpec;

  /** Validation after work */
  postchecks?: WorkSpec;

  /** Additional agent instructions (Markdown) */
  instructions?: string;

  /** Producer IDs this node depends on */
  dependencies: string[];

  /** Override base branch (root nodes only) */
  baseBranch?: string;
}
```

### 5.2 GroupSpec (User Input — replaces PlanSpec for multi-node DAGs)

```typescript
/**
 * Specification for creating a group of nodes.
 * This is the new equivalent of PlanSpec.
 */
interface GroupSpec {
  /** Human-readable group name */
  name: string;

  /** Repository path (defaults to workspace) */
  repoPath?: string;

  /** Base branch (default: main) */
  baseBranch?: string;

  /** Target branch for final merge */
  targetBranch?: string;

  /** Max concurrent nodes (default: 4) */
  maxParallel?: number;

  /** Clean up worktrees after merge (default: true) */
  cleanUpSuccessfulWork?: boolean;

  /** Nodes in this group */
  nodes: NodeSpec[];

  /**
   * Sub-groups (replaces subPlans).
   * Each sub-group becomes a child group with its own scheduling.
   */
  subGroups?: SubGroupSpec[];
}

/**
 * Sub-group specification (replaces SubPlanNodeSpec).
 * Flattened into the node registry at build time.
 */
interface SubGroupSpec {
  /** Producer ID for this sub-group (used as dependency target) */
  producerId: string;

  /** Display name */
  name?: string;

  /** Nodes within this sub-group */
  nodes: NodeSpec[];

  /** Nested sub-groups */
  subGroups?: SubGroupSpec[];

  /** Dependencies on nodes in the parent group */
  dependencies: string[];

  /** Max parallel within this sub-group */
  maxParallel?: number;
}
```

### 5.3 NodeInstance (Runtime — replaces PlanNode + NodeExecutionState)

```typescript
/**
 * Runtime node instance.
 * Combines what was previously split across PlanNode and NodeExecutionState.
 */
interface NodeInstance {
  /** UUID */
  id: string;

  /** User-controlled reference key */
  producerId: string;

  /** Display name */
  name: string;

  /** Task description */
  task: string;

  /** Work specification */
  work?: WorkSpec;

  /** Pre/post validation */
  prechecks?: WorkSpec;
  postchecks?: WorkSpec;

  /** Agent instructions */
  instructions?: string;

  /** Resolved dependency node IDs */
  dependencies: string[];

  /** Computed reverse edges */
  dependents: string[];

  /** Override base branch */
  baseBranch?: string;

  /** Optional group membership */
  group?: GroupInfo;

  // --- Execution state (previously NodeExecutionState) ---

  /** Current status */
  status: NodeStatus;

  /** Timestamps */
  scheduledAt?: number;
  startedAt?: number;
  endedAt?: number;

  /** Error message if failed */
  error?: string;

  /** Git context */
  baseCommit?: string;
  completedCommit?: string;
  worktreePath?: string;

  /** Repository path */
  repoPath: string;

  /** Retry tracking */
  attempts: number;
  attemptHistory?: AttemptRecord[];

  /** Merge tracking */
  mergedToTarget?: boolean;
  consumedByDependents?: string[];
  worktreeCleanedUp?: boolean;

  /** Phase-level status */
  stepStatuses?: {
    prechecks?: PhaseStatus;
    work?: PhaseStatus;
    commit?: PhaseStatus;
    postchecks?: PhaseStatus;
  };

  /** Session resumption */
  copilotSessionId?: string;

  /** Last attempt context */
  lastAttempt?: AttemptContext;

  /** Work summary on success */
  workSummary?: JobWorkSummary;
}
```

### 5.4 Re-exported Types (Unchanged)

The following types remain as-is:

- `NodeStatus`, `TERMINAL_STATES`, `VALID_TRANSITIONS`, `isTerminal()`, `isValidTransition()`
- `WorkSpec`, `ProcessSpec`, `ShellSpec`, `AgentSpec`, `normalizeWorkSpec()`
- `PhaseStatus`, `AttemptRecord`, `JobWorkSummary`, `CommitDetail`, `WorkSummary`
- `LogEntry`, `ExecutionPhase`
- `NodeTransitionEvent` (unchanged — already node-centric)

### 5.5 Derived Group Status (Replaces PlanStatus)

```typescript
/** Same values as current PlanStatus, now derived from grouped nodes */
type GroupStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'partial' | 'canceled';

/**
 * Computed group status snapshot (not stored — derived on demand).
 */
interface GroupStatusSnapshot {
  groupId: string;
  name: string;
  status: GroupStatus;
  progress: number;
  counts: Record<NodeStatus, number>;
  nodes: NodeInstance[];
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  workSummary?: WorkSummary;
}
```

## 6. API Changes

### 6.1 New MCP Tools

#### `create_copilot_node` — Create one or more independent nodes

Replaces `create_copilot_job` for single nodes and supports batching.

```json
{
  "name": "create_copilot_node",
  "inputSchema": {
    "type": "object",
    "required": ["nodes"],
    "properties": {
      "nodes": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["producer_id", "task", "dependencies"],
          "properties": {
            "producer_id": { "type": "string", "pattern": "^[a-z0-9-]{3,64}$" },
            "name": { "type": "string" },
            "task": { "type": "string" },
            "work": {},
            "prechecks": {},
            "postchecks": {},
            "instructions": { "type": "string" },
            "dependencies": { "type": "array", "items": { "type": "string" } },
            "base_branch": { "type": "string" }
          }
        }
      },
      "group": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "base_branch": { "type": "string" },
          "target_branch": { "type": "string" },
          "max_parallel": { "type": "integer", "minimum": 1 },
          "clean_up_successful_work": { "type": "boolean" }
        }
      }
    }
  }
}
```

**Semantics:**
- If `group` is omitted and `nodes` has one entry → standalone node (like current `create_copilot_job`).
- If `group` is provided → all nodes share the group (like current `create_copilot_plan`).
- If `group` is omitted and `nodes` has multiple entries → ungrouped batch; each node runs independently but dependencies between them are resolved.

#### `get_copilot_node` — Get node details (replaces `get_copilot_node_details`)

```json
{
  "name": "get_copilot_node",
  "inputSchema": {
    "type": "object",
    "required": ["node_id"],
    "properties": {
      "node_id": { "type": "string", "description": "UUID or producer_id" }
    }
  }
}
```

No `planId` required — nodes are looked up globally by ID.

#### `list_copilot_nodes` — Query nodes with filters

```json
{
  "name": "list_copilot_nodes",
  "inputSchema": {
    "type": "object",
    "properties": {
      "group_id": { "type": "string" },
      "status": { "type": "string", "enum": ["pending","ready","scheduled","running","succeeded","failed","blocked","canceled"] },
      "group_name": { "type": "string" }
    }
  }
}
```

### 6.2 Preserved Tools (Renamed/Adapted)

| Current Tool | New Tool | Change |
|---|---|---|
| `create_copilot_plan` | **Kept as-is** (adapter) | Internally calls `create_copilot_node` with a group. See §7 backward compat. |
| `create_copilot_job` | **Kept as-is** (adapter) | Internally calls `create_copilot_node` with a single ungrouped node. |
| `get_copilot_plan_status` | `get_copilot_group_status` | Accepts `group_id` instead of `id`. Old tool delegates to new. |
| `list_copilot_plans` | `list_copilot_groups` | Lists groups. Old tool delegates to new. |
| `cancel_copilot_plan` | `cancel_copilot_group` | Cancels all nodes in a group. Old tool delegates. |
| `delete_copilot_plan` | `delete_copilot_group` | Deletes all nodes in a group. Old tool delegates. |
| `retry_copilot_plan` | `retry_copilot_group` | Retries failed nodes in a group. Old tool delegates. |
| `get_copilot_node_details` | `get_copilot_node` | No `planId` parameter needed. Old tool delegates. |
| `get_copilot_node_logs` | **Unchanged** | `planId` → `group_id` (optional). Falls back to node lookup. |
| `get_copilot_node_attempts` | **Unchanged** | Same adaptation as logs. |
| `retry_copilot_plan_node` | `retry_copilot_node` | `planId` removed; node ID is sufficient. |
| `get_copilot_plan_node_failure_context` | `get_copilot_node_failure_context` | `planId` removed. |

### 6.3 Tool Removal (Deferred)

The old `*_plan*` tools are **not removed** — they become thin adapters. Removal happens in a future major version.

## 7. Migration Path

### 7.1 Adapter Layer (Backward Compatibility)

The old MCP handlers become adapters that translate to the new model:

```typescript
// src/mcp/handlers/legacyAdapters.ts

async function handleCreatePlan(args: any, ctx: NodeHandlerContext) {
  // Convert PlanSpec shape → GroupSpec + NodeSpec[]
  const groupSpec: GroupSpec = {
    name: args.name,
    baseBranch: args.base_branch,
    targetBranch: args.target_branch,
    maxParallel: args.max_parallel,
    cleanUpSuccessfulWork: args.clean_up_successful_work,
    nodes: args.jobs.map(mapJobToNodeSpec),
    subGroups: args.sub_plans?.map(mapSubPlanToSubGroup),
  };

  const result = await handleCreateGroup(groupSpec, ctx);

  // Return response in old format (planId, nodeMapping, etc.)
  return {
    success: result.success,
    planId: result.groupId,          // groupId aliased as planId
    name: result.name,
    nodeMapping: result.nodeMapping,
    status: result.status,
  };
}
```

### 7.2 Internal Data Migration

```
Current persistence:
  .orchestrator/plans/{planId}.json  →  PlanInstance serialization

New persistence:
  .orchestrator/nodes/{nodeId}.json  →  NodeInstance serialization
  .orchestrator/groups/{groupId}.json → GroupInfo serialization
```

**Migration strategy:**

1. On startup, `NodeRegistry.initialize()` checks for legacy `.orchestrator/plans/` data.
2. Each `PlanInstance` is decomposed:
   - `PlanInstance` → `GroupInfo` (plan-level fields)
   - Each `PlanNode` + `NodeExecutionState` → `NodeInstance` (merged)
   - Sub-plan `PlanInstance`s → child groups with `parentGroupId`
3. Legacy files are moved to `.orchestrator/plans.bak/` (one-time migration).
4. New files written in new format.

### 7.3 PlanRunner → NodeRunner Transition

| Component | Current | New |
|---|---|---|
| `PlanRunner` | Owns `Map<planId, PlanInstance>` | `NodeRunner` owns `NodeRegistry` (flat map of all nodes) |
| `PlanStateMachine` (per plan) | Drives node transitions within one plan | `NodeStateMachine` operates on any node; group-scoped queries derived |
| `PlanScheduler` | Global + per-plan `maxParallel` | `NodeScheduler` respects per-group `maxParallel` via `GroupInfo` |
| `PlanBuilder.buildPlan()` | Spec → Instance | `NodeBuilder.buildNodes()` returns `NodeInstance[]` + optional `GroupInfo` |
| `PlanPersistence` | Plan-level serialization | `NodePersistence` per-node + per-group serialization |

### 7.4 Phased Rollout

| Phase | Scope | Breaking? |
|---|---|---|
| **Phase 1** | Add `GroupInfo` to internal types. `PlanInstance` wraps `GroupInfo`. No API changes. | No |
| **Phase 2** | Introduce `create_copilot_node` and `list_copilot_nodes` MCP tools alongside existing tools. Both work. | No |
| **Phase 3** | Migrate `PlanRunner` internals to `NodeRegistry` + `NodeStateMachine`. Existing tools become adapters. | No |
| **Phase 4** | Deprecate old `*_plan*` tools (emit deprecation warnings in responses). | No |
| **Phase 5** | Remove deprecated tools (future major version). | Yes |

## 8. Interface Design for DI / Testing

### 8.1 INodeRegistry

```typescript
/**
 * Registry for node instances.
 * Replaces the plan-level Map<planId, PlanInstance>.
 */
interface INodeRegistry {
  /** Register a new node */
  register(node: NodeInstance): void;

  /** Get node by UUID */
  get(nodeId: string): NodeInstance | undefined;

  /** Get node by producer ID (within optional group scope) */
  getByProducerId(producerId: string, groupId?: string): NodeInstance | undefined;

  /** Get all nodes in a group */
  getByGroup(groupId: string): NodeInstance[];

  /** Get all ungrouped nodes */
  getUngrouped(): NodeInstance[];

  /** Get all nodes */
  getAll(): NodeInstance[];

  /** Remove a node */
  delete(nodeId: string): boolean;

  /** Check existence */
  has(nodeId: string): boolean;
}
```

### 8.2 INodeRunner

```typescript
/**
 * Orchestrator interface.
 * Replaces PlanRunner with a node-centric API.
 */
interface INodeRunner {
  /** Create nodes (optionally grouped) */
  createNodes(specs: NodeSpec[], group?: GroupSpec): Promise<NodeInstance[]>;

  /** Create a group of nodes from a GroupSpec */
  createGroup(spec: GroupSpec): Promise<{ groupId: string; nodes: NodeInstance[] }>;

  /** Get a node by ID */
  getNode(nodeId: string): NodeInstance | undefined;

  /** Get group status (derived from member nodes) */
  getGroupStatus(groupId: string): GroupStatusSnapshot | undefined;

  /** List all groups */
  listGroups(filter?: { status?: GroupStatus }): GroupInfo[];

  /** Cancel a node or all nodes in a group */
  cancel(nodeId: string): void;
  cancelGroup(groupId: string): void;

  /** Retry a failed node */
  retryNode(nodeId: string, newWork?: WorkSpec, clearWorktree?: boolean): Promise<void>;

  /** Delete a node (or group) and its history */
  deleteNode(nodeId: string): void;
  deleteGroup(groupId: string): void;

  /** Set the executor strategy */
  setExecutor(executor: INodeExecutor): void;

  /** Lifecycle */
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
}
```

### 8.3 INodeExecutor (Replaces JobExecutor)

```typescript
/**
 * Strategy interface for executing node work.
 * Replaces JobExecutor — same shape, renamed for consistency.
 */
interface INodeExecutor {
  execute(context: NodeExecutionContext): Promise<NodeExecutionResult>;
  cancel(nodeId: string): void;
  getLogs?(nodeId: string): LogEntry[];
  getLogsForPhase?(nodeId: string, phase: ExecutionPhase): LogEntry[];
  log?(nodeId: string, phase: ExecutionPhase, type: 'info' | 'error' | 'stdout' | 'stderr', message: string): void;
}

/**
 * Context passed to executor (replaces ExecutionContext).
 * No longer references PlanInstance — node is self-contained.
 */
interface NodeExecutionContext {
  node: NodeInstance;
  baseCommit: string;
  worktreePath: string;
  onProgress?: (step: string) => void;
  abortSignal?: AbortSignal;
  copilotSessionId?: string;
}

/** Same shape as JobExecutionResult, renamed */
type NodeExecutionResult = JobExecutionResult;
```

### 8.4 INodeStateMachine

```typescript
/**
 * State machine for node transitions.
 * Operates on individual nodes; group-level status is derived.
 */
interface INodeStateMachine {
  /** Transition a node to a new status */
  transition(nodeId: string, newStatus: NodeStatus, updates?: Partial<NodeInstance>): boolean;

  /** Check if a node's dependencies are all succeeded */
  areDependenciesMet(nodeId: string): boolean;

  /** Propagate blocked status to dependents of a failed node */
  propagateBlocked(failedNodeId: string): void;

  /** Get nodes ready for scheduling (optionally scoped to group) */
  getReadyNodes(groupId?: string): NodeInstance[];

  /** Compute derived group status */
  computeGroupStatus(groupId: string): GroupStatus;

  /** Reset node for retry */
  resetNodeToPending(nodeId: string): void;
}
```

### 8.5 INodePersistence

```typescript
/**
 * Persistence interface for nodes and groups.
 */
interface INodePersistence {
  saveNode(node: NodeInstance): Promise<void>;
  loadNode(nodeId: string): Promise<NodeInstance | undefined>;
  deleteNode(nodeId: string): Promise<void>;
  loadAllNodes(): Promise<NodeInstance[]>;

  saveGroup(group: GroupInfo): Promise<void>;
  loadGroup(groupId: string): Promise<GroupInfo | undefined>;
  deleteGroup(groupId: string): Promise<void>;
  loadAllGroups(): Promise<GroupInfo[]>;

  /** One-time migration from legacy PlanInstance format */
  migrateLegacyPlans?(): Promise<{ migrated: number; errors: string[] }>;
}
```

## 9. Key Design Decisions

### 9.1 Why Merge Node Definition + Execution State?

Currently `PlanNode` (static definition) and `NodeExecutionState` (runtime state) are stored separately in `PlanInstance.nodes` and `PlanInstance.nodeStates`. In the new model, `NodeInstance` combines both.

**Rationale:** Nodes are self-contained units. Splitting definition from state only made sense when the Plan was the primary container. With nodes as first-class, a single `NodeInstance` object is simpler to reason about, serialize, and pass to executors.

**Trade-off:** Slightly larger objects in memory. Mitigated by the fact that node counts are typically small (< 100).

### 9.2 Why Keep SubGroups Instead of Fully Flat?

The `SubGroupSpec` in `GroupSpec` preserves the ability to define nested scope for producer IDs and per-sub-group `maxParallel`. At build time, sub-groups are **flattened** into the global node registry with a child `GroupInfo`.

This avoids the runtime complexity of nested `PlanInstance` trees while preserving the input convenience of hierarchical specs.

### 9.3 Why Not Remove Groups Entirely?

Groups serve three purposes that ungrouped nodes cannot:
1. **Shared target branch** — leaf nodes in a group merge to one target.
2. **Shared maxParallel** — scheduling budget across related work.
3. **Aggregate status** — "is the whole feature done?" requires grouping.

Without groups, users would need to manually coordinate these concerns per-node.

### 9.4 Global Node Lookup vs. Scoped Lookup

Currently, `get_copilot_node_details` requires `planId` + `nodeId`. The new `get_copilot_node` only needs `nodeId` because `NodeRegistry` is global.

**Collision handling:** Producer IDs are unique within a group scope. For global lookup by producer ID, the caller must provide `groupId` to disambiguate. UUID lookups are always unambiguous.

## 10. Example Usage

### 10.1 Standalone Node (Replaces create_copilot_job)

```json
{
  "tool": "create_copilot_node",
  "arguments": {
    "nodes": [{
      "producer_id": "fix-login-bug",
      "task": "Fix the login validation bug in auth.ts",
      "work": { "type": "agent", "instructions": "# Fix login bug\n..." },
      "dependencies": []
    }]
  }
}
```

### 10.2 Grouped Nodes (Replaces create_copilot_plan)

```json
{
  "tool": "create_copilot_node",
  "arguments": {
    "group": {
      "name": "Add user settings feature",
      "target_branch": "feature/user-settings"
    },
    "nodes": [
      {
        "producer_id": "settings-model",
        "task": "Create the settings data model",
        "dependencies": []
      },
      {
        "producer_id": "settings-api",
        "task": "Create REST endpoints for settings CRUD",
        "dependencies": ["settings-model"]
      },
      {
        "producer_id": "settings-ui",
        "task": "Build the settings page UI",
        "dependencies": ["settings-api"]
      }
    ]
  }
}
```

### 10.3 Querying Nodes

```json
{
  "tool": "list_copilot_nodes",
  "arguments": { "status": "failed" }
}
```

```json
{
  "tool": "get_copilot_node",
  "arguments": { "node_id": "settings-api" }
}
```

## 11. File Changes Summary

| File | Change |
|---|---|
| `src/plan/types/nodes.ts` | Add `NodeSpec`, `NodeInstance`, deprecate `SubPlanNode` |
| `src/plan/types/plan.ts` | Add `GroupInfo`, `GroupSpec`, `SubGroupSpec`, `GroupStatus`, `GroupStatusSnapshot` |
| `src/plan/types/specs.ts` | No changes |
| `src/plan/types/index.ts` | Re-export new types |
| `src/interfaces/INodeRunner.ts` | New: `INodeRunner`, `INodeRegistry`, `INodeExecutor`, `INodeStateMachine`, `INodePersistence` |
| `src/interfaces/index.ts` | Export new interfaces |
| `src/plan/builder.ts` | Add `buildNodes()` alongside existing `buildPlan()` |
| `src/plan/runner.ts` | Refactor to `NodeRunner` implementing `INodeRunner`; keep `PlanRunner` as deprecated re-export |
| `src/plan/stateMachine.ts` | Refactor to `NodeStateMachine` implementing `INodeStateMachine` |
| `src/mcp/tools/planTools.ts` | Add new tool definitions; keep old as deprecated |
| `src/mcp/handlers/planHandlers.ts` | Add new handlers; refactor old handlers to adapters |
| `src/mcp/handlers/nodeHandlers.ts` | New: handlers for `create_copilot_node`, `get_copilot_node`, etc. |
| `src/mcp/handlers/legacyAdapters.ts` | New: adapter wrappers for backward-compatible plan tools |
| `src/mcp/handlers/utils.ts` | Add `lookupNode()` global variant (no plan context needed) |
| `src/mcp/handler.ts` | Route new tool names to new handlers |

## 12. Open Questions

1. **Event naming** — Should `NodeTransitionEvent` remain as-is, or should group-level events (`groupCompleted`) be added?
2. **Persistence granularity** — Per-node files may create many small files. Consider a single JSON file per group + individual files for ungrouped nodes.
3. **Cross-group dependencies** — Should nodes in different groups be able to depend on each other? Current sub-plan model doesn't support this; the flat model could.
4. **Producer ID global uniqueness** — Should producer IDs be globally unique across all groups, or only within a group scope? Global uniqueness simplifies lookup but constrains naming.
