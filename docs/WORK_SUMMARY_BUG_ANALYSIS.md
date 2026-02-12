# Work Summary Fallback Bug Analysis

## Overview

In `src/ui/panels/planDetailPanel.ts`, there is a bug in the work summary display logic that defeats the purpose of the `computeMergedLeafWorkSummary` function. The bug manifests as incorrect fallback behavior when no leaf nodes have merged to the target branch.

## Root Cause

### The Problem Code

There are **two instances** of this bug in `planDetailPanel.ts`:

**Instance 1: `_buildWorkSummaryHtml` method (lines ~2278-2285)**
```typescript
let workSummary = plan.targetBranch 
  ? computeMergedLeafWorkSummary(plan, plan.nodeStates)
  : plan.workSummary;

// Fall back to plan.workSummary if filtered result is undefined
if (!workSummary) {
  workSummary = plan.workSummary;  // BUG!
}
```

**Instance 2: Job details section (line 239)**
```typescript
const summary = plan.targetBranch 
  ? computeMergedLeafWorkSummary(plan, plan.nodeStates) || plan.workSummary  // BUG!
  : plan.workSummary;
```

### Why This Is Wrong

1. **`computeMergedLeafWorkSummary` correctly returns `undefined`** when no leaf nodes have `mergedToTarget === true`
2. **The fallback defeats the function's purpose** by showing ALL completed work instead of only merged leaf work
3. **Users see confusing information** - work from non-merged nodes (like `analyze-current`) appears as if it has been merged to the target branch

### The Intended Behavior

According to the test suite (`src/test/suite/plan/helpers.test.ts`, lines 457-474), `computeMergedLeafWorkSummary` is designed to:
- Return `undefined` when no leaf nodes have merged to target
- Only show work from leaves with `mergedToTarget === true`
- Filter out work from non-merged ancestors

## The Fix

The fallback should **only apply when there's no target branch**, not when the filtered result is empty:

**For `_buildWorkSummaryHtml` method:**
```typescript
let workSummary = plan.targetBranch 
  ? computeMergedLeafWorkSummary(plan, plan.nodeStates)
  : plan.workSummary;

// Only fall back when there's no target branch AND no work summary
// When targetBranch is set, respect undefined result (no merged leaves)
if (!workSummary && !plan.targetBranch) {
  workSummary = plan.workSummary;
}
```

**For job details section:**
```typescript
const summary = plan.targetBranch 
  ? computeMergedLeafWorkSummary(plan, plan.nodeStates)
  : plan.workSummary;

// Handle undefined case appropriately (show empty section or message)
if (!summary) {
  // Show nothing when no work has been merged to target
  return;
}
```

## Expected User Experience at Each Plan Stage

### Stage 1: Plan Created, No Execution
- **Current Behavior**: No work summary shown ✓ (correct)
- **Expected**: No work summary shown ✓

### Stage 2: Nodes Executing, None Merged
- **Current Behavior**: Shows ALL work including non-merged ancestors ❌ (bug)
- **Expected**: Show nothing or "No work merged to target yet"

### Stage 3: Some Leaves Merged, Some Not
- **Current Behavior**: Shows ALL work ❌ (bug)
- **Expected**: Show only work from merged leaves

### Stage 4: All Leaves Merged
- **Current Behavior**: Shows correct merged work ✓ (works by accident)
- **Expected**: Shows correct merged work ✓

### Plans Without Target Branch
- **Current Behavior**: Shows all work ✓ (correct)
- **Expected**: Shows all work ✓ (backward compatibility)

## Impact

This bug causes user confusion because:
1. Work appears "merged" when it hasn't been merged to the target branch
2. Users cannot distinguish between completed work and actually integrated work
3. The UI misleads users about the current state of their integration

## Implementation Notes

The fix requires:
1. Removing the incorrect fallback logic in both locations
2. Ensuring the UI gracefully handles empty work summaries when target branch is set
3. Maintaining backward compatibility for plans without target branches

## Test Coverage

The existing test `"returns undefined when no leaf nodes are merged"` in `src/test/suite/plan/helpers.test.ts` validates the correct behavior of `computeMergedLeafWorkSummary`. The UI components should respect this undefined return value instead of falling back to showing all work.