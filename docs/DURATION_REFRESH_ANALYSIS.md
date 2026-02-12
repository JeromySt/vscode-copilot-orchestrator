# Plan Tree View Duration Refresh Issue Analysis

## Problem Statement
The plan tree panel shows duration for running plans (e.g., "2m 30s"), but the duration doesn't update while the plan is running. It stays static until some other event triggers a refresh.

## Expected Behavior
- Running plans should show continuously updating duration
- Update every ~1 second or at least every few seconds  
- Non-running plans can show final duration (static)

## Architecture Analysis

### Duration Display Components

The plan tree functionality is split across two main UI components:

#### 1. plansViewProvider.ts (Main Webview Sidebar)
**Location**: `src/ui/plansViewProvider.ts`

**Duration Calculation**: 
- **Location**: Lines 424-435 (JavaScript function in HTML)
- **Function**: `formatDuration(start, end)`
- **Implementation**: `(end || Date.now()) - start`
- **Format**: Returns strings like "2m 30s", "1h 5m", etc.

**Timer Implementation**:
- **Location**: Lines 126-136
- **Interval**: 1000ms (1 second)
- **Condition**: Only runs when plans have 'running' or 'pending' status
- **Behavior**: ✅ **WORKING** - Duration updates continuously for running plans

#### 2. planTreeProvider.ts (TreeView for Activity Badge)  
**Location**: `src/ui/planTreeProvider.ts`

**Duration Display**: 
- **Current**: ❌ **NOT IMPLEMENTED** - Only shows node count in description
- **Location**: Line 35 `getPlanStatusDescription()` returns `(${nodeCount} nodes)`

**Refresh Mechanism**:
- **Current**: ❌ **EVENT-DRIVEN ONLY** - No timer implementation
- **Events**: planCreated, planDeleted, planStarted, planCompleted, planUpdated, nodeTransition
- **Problem**: Events don't fire continuously for duration updates

## Current Refresh Triggers

### plansViewProvider.ts
- ✅ **Timer**: 1-second interval for running/pending plans
- ✅ **Events**: planCreated, planCompleted, planDeleted, nodeTransition
- ✅ **Result**: Live duration updates work correctly

### planTreeProvider.ts
- ❌ **Timer**: None
- ✅ **Events**: planCreated, planDeleted, planStarted, planCompleted, planUpdated, nodeTransition
- ❌ **Result**: Duration stays static (no duration display implemented)

## Root Cause Analysis

The issue is in `planTreeProvider.ts`:

1. **No Timer**: Unlike plansViewProvider, there's no setInterval for periodic refresh
2. **No Duration Display**: The tree items don't show duration at all
3. **Event-Only Refresh**: Relies on plan state change events, which don't fire for duration ticks

## Proposed Implementation

### Location for Timer
`src/ui/planTreeProvider.ts` in the `PlanTreeViewManager` class

### Implementation Pattern
Follow the same pattern as plansViewProvider.ts:

```typescript
// In PlanTreeViewManager constructor or createTreeView method
this._refreshTimer = setInterval(() => {
  const hasRunning = this.planRunner.getAll().some(plan => {
    const sm = this.planRunner.getStateMachine(plan.id);
    const status = sm?.computePlanStatus();
    return status === 'running' || status === 'pending';
  });
  
  if (hasRunning) {
    this.treeDataProvider.refresh();
  }
}, 1000);
```

### Duration Display Enhancement
Modify `PlanTreeItem.getPlanStatusDescription()` to include duration for running plans:

```typescript
private getPlanStatusDescription(plan: PlanInstance): string {
  const nodeCount = plan.nodes.size;
  let description = `(${nodeCount} nodes)`;
  
  // Add duration for running plans
  if (plan.startedAt) {
    const sm = this.planRunner.getStateMachine(plan.id);
    const status = sm?.computePlanStatus();
    
    if (status === 'running' || status === 'pending') {
      const duration = Date.now() - plan.startedAt;
      const durationStr = formatDuration(duration);
      description = `${durationStr} • ${description}`;
    }
  }
  
  return description;
}
```

### Cleanup Requirements
- Add timer cleanup in disposal methods
- Follow existing patterns from plansViewProvider.ts for timer management

## Files to Modify

1. **`src/ui/planTreeProvider.ts`**
   - Add timer to `PlanTreeViewManager`
   - Enhance `PlanTreeItem.getPlanStatusDescription()` 
   - Add duration formatting utility import
   - Add timer cleanup on disposal

2. **Duration Utility**
   - Import from existing `src/ui/templates/helpers.ts` (`formatDurationMs`)
   - Or implement inline following plansViewProvider.ts pattern

## Implementation Priority

**High Priority**: The tree view is likely the primary interface users see for duration display, making this a user-facing functionality gap.