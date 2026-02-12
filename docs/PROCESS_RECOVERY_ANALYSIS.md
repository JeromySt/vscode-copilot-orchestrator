# Process Recovery Analysis: Extension Re-Init

## Problem Statement

When the Copilot Orchestrator extension re-initializes (VS Code reload, extension host restart), nodes that were previously "running" may have their associated processes terminated. Currently, these nodes may be left in a stuck "running" state instead of being marked as failed.

## Current Behavior Investigation

### 1. Extension Activation and Plan Loading

In `src/extension.ts`, the extension follows this initialization sequence:
1. Logger initialization 
2. Configuration loading
3. Plan Runner initialization via `initializePlanRunner()`
4. Global Capacity Manager setup
5. MCP Server setup
6. UI component initialization

The key method in `src/core/planInitialization.ts:223`:
```typescript
// Initialize (load persisted Plans)
planRunner.initialize().catch(err => {
  log.error('Failed to initialize Plan Runner', { error: err.message });
});
```

### 2. Plan Loading Without Process Validation

In `src/plan/runner.ts:initialize()`:
```typescript
async initialize(): Promise<void> {
  log.info('Initializing Plan Runner');
  
  // Load persisted Plans
  const loadedPlans = this.persistence.loadAll();
  for (const plan of loadedPlans) {
    this.plans.set(plan.id, plan);
    const sm = new PlanStateMachine(plan);
    this.setupStateMachineListeners(sm);
    this.stateMachines.set(plan.id, sm);
  }
  
  log.info(`Loaded ${loadedPlans.length} Plans from persistence`);
  
  // Start the pump
  this.startPump();
  this.isRunning = true;
}
```

**Key Issue**: Plans are loaded with their persisted state, including nodes with status "running", but there's **no validation** that the processes are still alive.

### 3. Process State Management

#### Process ID Storage
From `src/plan/executor.ts`, the executor tracks active processes in memory only:
- `activeExecutions: Map<string, ActiveExecution>` - contains process references
- `ActiveExecution.process?: ChildProcess` - holds the actual process reference and PID

#### Process State NOT Persisted
The investigation reveals that **process IDs are NOT persisted** in the node state. Looking at `src/plan/types/plan.ts`:

```typescript
export interface NodeExecutionState {
  status: NodeStatus;
  version: number;
  scheduledAt?: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  baseCommit?: string;
  completedCommit?: string;
  worktreePath?: string;
  attempts: number;
  workSummary?: JobWorkSummary;
  // ... NO PROCESS ID FIELD
}
```

The `sessionId` field is present for Copilot CLI session resumption but not for process tracking.

#### Process Monitor Capabilities
The `ProcessMonitor` class in `src/process/processMonitor.ts` provides:
- `isRunning(pid: number): boolean` - checks if a process exists
- Process tree monitoring
- Process termination capabilities

### 4. Current Recovery Gap

**The Problem**: When extension restarts:

1. **Plans load with "running" nodes** - `persistence.loadAll()` restores nodes with `status: "running"`
2. **No process validation occurs** - the initialize method doesn't check if processes are still alive  
3. **Executor state is empty** - `activeExecutions` map is empty (in-memory only)
4. **Nodes remain stuck** - "running" nodes can't proceed because their processes are gone

## Root Cause Analysis

1. **Process IDs not persisted**: The `NodeExecutionState` doesn't store process IDs
2. **No recovery validation**: The initialization doesn't validate process existence
3. **In-memory process tracking**: The executor's `activeExecutions` is not persisted
4. **State machine assumes continuity**: Loaded "running" nodes assume their processes still exist

## Proposed Fix Approach

### Solution 1: Add Process Recovery on Startup (Recommended)

Add process validation during plan loading:

```typescript
// In src/plan/runner.ts:initialize()
async initialize(): Promise<void> {
  log.info('Initializing Plan Runner');
  
  // Load persisted Plans
  const loadedPlans = this.persistence.loadAll();
  for (const plan of loadedPlans) {
    // Validate and recover running nodes
    this.recoverRunningNodes(plan);
    
    this.plans.set(plan.id, plan);
    const sm = new PlanStateMachine(plan);
    this.setupStateMachineListeners(sm);
    this.stateMachines.set(plan.id, sm);
  }
  
  log.info(`Loaded ${loadedPlans.length} Plans from persistence`);
  this.startPump();
  this.isRunning = true;
}

private recoverRunningNodes(plan: PlanInstance): void {
  for (const [nodeId, node] of plan.nodes) {
    if (node.status === 'running') {
      // Mark as failed since process is gone
      node.status = 'failed';
      node.error = 'Process terminated during extension restart';
      node.endedAt = Date.now();
      
      log.info(`Recovered orphaned running node: ${nodeId}`, {
        planId: plan.id, 
        nodeName: node.spec.name
      });
    }
  }
}
```

### Solution 2: Persist Process IDs (Alternative)

Add process ID to node state and validate on startup:

```typescript
// In src/plan/types/plan.ts
export interface NodeExecutionState {
  // ... existing fields ...
  processId?: number; // Add this field
}
```

Then implement process existence checking using `ProcessMonitor.isRunning()`.

### Solution 3: Hybrid Approach (Most Robust)

Combine both approaches:
1. Add optional `processId` field for future use
2. Implement immediate recovery for existing "running" nodes
3. Add process validation for future executions

## Implementation Location

**Primary changes needed in**:
- `src/plan/runner.ts` - Add `recoverRunningNodes()` method
- Call recovery during `initialize()`
- Optionally add `processId` to `NodeExecutionState` type

**Files to modify**:
1. `src/plan/runner.ts` - Add recovery logic
2. `src/plan/types/plan.ts` - Add optional `processId` field (for future)
3. `src/plan/persistence.ts` - Ensure recovery changes are persisted

## Testing Strategy

1. **Create test plan with running node**
2. **Simulate extension restart** by stopping and restarting extension
3. **Verify node state** changes from "running" to "failed"
4. **Check logs** for recovery messages
5. **Ensure pump continues** processing other nodes correctly

This fix will ensure that when the extension restarts, any nodes that were "running" are properly marked as failed rather than remaining stuck, allowing users to retry them manually or have the system handle them appropriately.