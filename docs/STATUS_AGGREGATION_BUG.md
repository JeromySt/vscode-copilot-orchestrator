# Plan Status Aggregation Bug Analysis

## Problem
When a node is marked as "crashed/failed" during extension re-init, the plan tree view still shows "running" instead of updating to "partial".

## Investigation Results

### 1. Plan Status Calculation Logic
**Location**: `src/plan/helpers.ts:110-209` - `computePlanStatus()` function

The status calculation logic is correct and handles failed nodes properly:
- `hasRunning || hasScheduled` → returns `'running'`
- `hasFailed && hasSucceeded` → returns `'partial'`
- `hasFailed` (only) → returns `'failed'`

The logic accounts for "failed" status nodes correctly, so this is not the issue.

### 2. Tree View Data Provider
**Location**: `src/ui/plansViewProvider.ts:55-72` - Event listeners in constructor

The PlansViewProvider listens to these events:
- `'planCreated'` → immediate refresh
- `'planCompleted'` → refresh  
- `'planDeleted'` → refresh
- `'nodeTransition'` → **scheduleRefresh()** (debounced)

This is the key: the tree view **does** listen for `nodeTransition` events which should trigger a refresh.

### 3. Crash Recovery Event Emission
**Location**: `src/plan/runner.ts:346-377` - `recoverRunningNodes()` method

**PROBLEM FOUND**: The crash recovery code only emitted `'nodeCompleted'` events and not the required `'nodeTransition'` events that the UI depends on for refreshes.

### 4. Comparison with Other Node Failure Code
**Location**: `src/plan/runner.ts:3417-3419` - `forceFailNode()` method

When manually failing a node, the code properly emits multiple events, but was using incorrect signature for `nodeTransition`.

### 5. Event Interface Requirements
**Location**: `src/plan/types/plan.ts:492-498` - `NodeTransitionEvent` interface

```ts
export interface NodeTransitionEvent {
  planId: string;
  nodeId: string;
  from: NodeStatus;
  to: NodeStatus;
  timestamp: number;
}
```

## Root Cause Analysis

The crash recovery code (`recoverRunningNodes`) failed to emit the `'nodeTransition'` event that the UI tree view depends on for refreshes. The PlansViewProvider listens for `nodeTransition` events and calls `scheduleRefresh()`, but this never happened during crash recovery.

## The Fix Applied

### Primary Fix - Crash Recovery Events
**File**: `src/plan/runner.ts` lines 360-369 and 375-384

Added proper `'nodeTransition'` event emission after marking nodes as crashed:

```ts
// Emit transition and completion events
const transitionEvent: NodeTransitionEvent = {
  planId: plan.id,
  nodeId,
  from: 'running',
  to: 'failed',
  timestamp: Date.now()
};
this.emit('nodeTransition', transitionEvent);
this.emit('nodeCompleted', plan.id, nodeId, false);
```

### Secondary Fix - Event Interface Compliance
**File**: `src/plan/runner.ts` line 3432-3440

Fixed `forceFailNode` method to use correct NodeTransitionEvent object:

```ts
// Emit events
const transitionEvent: NodeTransitionEvent = {
  planId,
  nodeId,
  from: 'running',
  to: 'failed',
  timestamp: Date.now()
};
this.emit('nodeTransition', transitionEvent);
```

### Test Updates
- Updated test mocks to match implementation
- Added test to verify `nodeTransition` event emission during crash recovery
- All existing tests continue to pass

## Verification

After the fix:
1. Crash recovery now properly emits `nodeTransition` events
2. PlansViewProvider receives these events and triggers UI refresh
3. Plan status calculation correctly identifies `hasFailed && hasSucceeded` → `'partial'`
4. Tree view updates from "running" to "partial" as expected

This resolves the issue where the plan tree view status didn't update when nodes crashed during extension re-init.