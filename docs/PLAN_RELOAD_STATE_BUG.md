# Plan State Reconciliation Bug After Extension Reload

## Problem Description

After extension reload, the plan status shown in the tree view is incorrect:
- Tree view shows plan status as "RUNNING" 
- But individual nodes show as "Crashed" (failed state)
- Plan status should be "partial" or "failed", not "running"

This occurs because plan status isn't properly recalculated after crash recovery marks nodes as failed.

## Root Cause Analysis

### Current (Broken) Execution Order

1. `planRunner.initialize()` starts asynchronously (planInitialization.ts:184)
2. **Tree view manager is created synchronously** (planInitialization.ts:322-324) 
3. **Tree view registers event listeners** in constructor (planTreeProvider.ts:66-72)
4. **Inside initialize loop**: for each loaded plan:
   a. `recoverRunningNodes(plan)` runs (runner.ts:392)
   b. **Crashed nodes emit `nodeCompleted` events** (runner.ts:361, 372)
   c. **Tree view immediately refreshes** via event listener (planTreeProvider.ts:72)
   d. **Tree view calls `getChildren()`** which calls `sm?.computePlanStatus()` (planTreeProvider.ts:41)
   e. **State machine doesn't exist yet** (`this.stateMachines.set()` happens after recovery - runner.ts:397)
   f. **Falls back to cached/stale status from disk** 
5. State machines are created **after** crash recovery (runner.ts:395-397)

### Why Status Calculation Fails

The tree view calculates plan status in `getPlanStatusDescription()` by calling:
```typescript
const sm = this.planRunner.getStateMachine(plan.id);  // Returns undefined during recovery!
const status = sm?.computePlanStatus();               // Never called - uses stale data
```

During crash recovery, the state machine doesn't exist yet, so:
- `getStateMachine()` returns `undefined`
- `sm?.computePlanStatus()` is never called
- Tree view shows duration for "running" status based on plan.startedAt
- Plan appears running even though nodes are failed

## Expected (Correct) Flow

1. `planRunner.initialize()` starts
2. For each loaded plan:
   a. `recoverRunningNodes(plan)` - mark crashed nodes as failed
   b. Create state machine 
   c. **THEN** add to plans map and emit events
3. Tree view registers listeners **after** initialization completes
4. Tree view shows correct status based on post-recovery state

## Technical Details

### File Locations

- **Plan loading**: `src/plan/runner.ts:385-410` (`initialize()`)
- **Crash recovery**: `src/plan/runner.ts:346-377` (`recoverRunningNodes()`) 
- **Status calculation**: `src/plan/stateMachine.ts:470-472` (`computePlanStatus()`)
- **Tree view**: `src/ui/planTreeProvider.ts:34-51` (`getPlanStatusDescription()`)
- **Initialization order**: `src/core/planInitialization.ts:184, 322-324`

### Event Flow Issue

Crash recovery emits events before state machines exist:
```typescript
// runner.ts:361, 372 - Inside recoverRunningNodes()
this.emit('nodeCompleted', plan.id, nodeId, false);

// planTreeProvider.ts:72 - Tree view listener  
this.planRunner.on('nodeCompleted', () => this.refresh());

// planTreeProvider.ts:41 - Status calculation fails
const sm = this.planRunner.getStateMachine(plan.id);  // undefined!
const status = sm?.computePlanStatus();
```

## Proposed Fix

### Option 1: Defer Event Emission (Recommended)

Move event emission until after state machines are created:

1. Modify `recoverRunningNodes()` to collect recovery events instead of emitting immediately
2. After all plans are loaded and state machines created, emit collected events
3. This ensures tree view calculates status correctly

### Option 2: Defer Tree View Registration  

Register tree view after plan runner initialization completes:

1. Make `planRunner.initialize()` awaitable in planInitialization.ts
2. Register tree view manager after `await planRunner.initialize()` 
3. This ensures events only fire after tree view is ready

### Option 3: Fix Status Fallback

Improve tree view status calculation to handle missing state machines:

1. If state machine doesn't exist, calculate status directly from node states
2. Use helper function `computePlanStatus(plan.nodeStates.values(), !!plan.startedAt, !!plan.isPaused)`
3. This makes tree view more robust but doesn't fix the timing issue

## Recommendation

**Option 1 (Defer Event Emission)** is recommended because:
- Fixes the root timing issue
- Maintains current architecture
- Ensures events are only emitted when all infrastructure is ready
- Minimal code changes required

Implementation would involve:
1. Modify `recoverRunningNodes()` to return an array of events instead of emitting
2. Collect events during the initialization loop
3. Emit all collected events after state machines are created