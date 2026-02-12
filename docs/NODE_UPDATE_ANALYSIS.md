# Node Update and Execution State Reset Analysis

## Problem Statement

Currently `update_copilot_plan_node` (or `retry_copilot_node`) accepts `newWork` but:
1. It may not reset the execution state properly to allow re-running the work stage
2. It doesn't support updating prechecks/postchecks in the same call
3. If a node passed work but failed postchecks, updating work should reset back to work stage

## Current Implementation Analysis

### 1. Update/Retry Handler

**Handler Location**: `src/mcp/handlers/nodeHandlers.ts:handleRetryNode()`
**Tool Definition**: `src/mcp/tools/nodeTools.ts` - `retry_copilot_node` tool

**Current Parameters**:
- `node_id`: string (required) - Node UUID or producer_id
- `newWork`: WorkSpec (optional) - String, ProcessSpec, ShellSpec, or AgentSpec
- `clearWorktree`: boolean (optional, default: false) - Reset worktree to base commit

**Current Behavior**:
- Only accepts `newWork` parameter for updating work specification
- Does NOT support updating `prechecks` or `postchecks` in the same call
- Validation includes model validation, folder validation, and URL validation
- Delegates to `PlanRunner.retryNode()` with options

### 2. Node Execution State Structure

**Location**: `src/plan/types/plan.ts:NodeExecutionState`

**Key Execution State Fields**:
```typescript
interface NodeExecutionState {
  status: NodeStatus;              // 'pending' | 'ready' | 'scheduled' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'canceled'
  
  // Phase-level status tracking
  stepStatuses?: {
    'merge-fi'?: PhaseStatus;      // 'pending' | 'running' | 'success' | 'failed' | 'skipped'
    prechecks?: PhaseStatus;
    work?: PhaseStatus;
    commit?: PhaseStatus;
    postchecks?: PhaseStatus;
    'merge-ri'?: PhaseStatus;
  };
  
  // Resume functionality
  resumeFromPhase?: 'prechecks' | 'work' | 'postchecks' | 'commit' | 'merge-ri';
  
  // Attempt tracking
  lastAttempt?: {
    phase: 'prechecks' | 'work' | 'commit' | 'postchecks' | 'merge-fi' | 'merge-ri';
    startTime: number;
    endTime?: number;
    error?: string;
    exitCode?: number;
  };
  
  // Auto-heal tracking per phase
  autoHealAttempted?: Partial<Record<'prechecks' | 'work' | 'postchecks', boolean>>;
}
```

### 3. Runner Retry Logic

**Location**: `src/plan/runner.ts:retryNode()`

**Current RetryNodeOptions**:
```typescript
export interface RetryNodeOptions {
  newWork?: WorkSpec;              // ✅ Supported
  newPrechecks?: WorkSpec | null;  // ✅ Supported (not exposed in MCP tool)
  newPostchecks?: WorkSpec | null; // ✅ Supported (not exposed in MCP tool)  
  clearWorktree?: boolean;         // ✅ Supported
}
```

**Phase Reset Logic** (lines 3580-3600):
```typescript
const shouldResetPhases = hasNewWork || hasNewPrechecks || options?.clearWorktree;

if (shouldResetPhases) {
  // Starting fresh - clear all phase progress
  nodeState.stepStatuses = undefined;
  nodeState.resumeFromPhase = undefined;
} else if (hasNewPostchecks && failedPhase === 'postchecks') {
  // Only postchecks changed and failure was at postchecks - resume from postchecks
  nodeState.resumeFromPhase = 'postchecks';
} else {
  // Resuming - preserve step statuses and set resume point
  if (failedPhase) {
    nodeState.resumeFromPhase = failedPhase;
  }
  // stepStatuses are preserved - completed phases will be skipped
}
```

## Current Behavior Analysis

### Phase Execution Sequence
1. **merge-fi**: Forward-integrate from upstream dependencies
2. **prechecks**: Validation before work
3. **work**: Main execution (shell/process/agent)
4. **commit**: Commit changes to git
5. **postchecks**: Validation after work  
6. **merge-ri**: Reverse-integrate to downstream dependents

### Retry Scenarios

| Scenario | Current Behavior | `stepStatuses` Reset | `resumeFromPhase` Set |
|----------|------------------|---------------------|---------------------|
| `newWork` only | ✅ Reset to fresh state | ✅ Cleared | ✅ Cleared (starts from merge-fi) |
| `newPrechecks` only | ✅ Reset to fresh state | ✅ Cleared | ✅ Cleared (starts from merge-fi) |
| `newPostchecks` only, failed at postchecks | ✅ Resume from postchecks | ⚠️ Preserved | ✅ Set to 'postchecks' |
| `newPostchecks` only, failed at work | ⚠️ Resume from work phase | ⚠️ Preserved | ✅ Set to 'work' |
| No changes | ✅ Resume from failed phase | ⚠️ Preserved | ✅ Set to failed phase |
| `clearWorktree=true` | ✅ Reset to fresh state | ✅ Cleared | ✅ Cleared |

**✅ = Correct behavior, ⚠️ = Potentially problematic behavior**

### Issues Identified

1. **MCP Tool Limitation**: `retry_copilot_node` tool doesn't expose `newPrechecks`/`newPostchecks` parameters
2. **Phase Reset Logic**: When only `newPostchecks` is provided but failure was NOT at postchecks, the logic preserves the previous phase statuses which may be incorrect
3. **Work Updates Don't Always Reset to Work Stage**: If a node passed work (stepStatuses.work = 'success') but failed at postchecks, providing `newWork` should ideally reset to the work stage, but current logic resets to the very beginning (merge-fi)

## Proposed Enhancements

### 1. Enhanced MCP Tool Schema

Update `retry_copilot_node` tool to support:
```typescript
{
  node_id: string;
  newWork?: WorkSpec;
  newPrechecks?: WorkSpec | null;  // NEW
  newPostchecks?: WorkSpec | null; // NEW  
  clearWorktree?: boolean;
}
```

### 2. Improved Phase Reset Logic

**Smart Phase Reset Rules**:
1. `newWork` provided → Reset to 'work' stage (preserve merge-fi and prechecks if they succeeded)
2. `newPrechecks` provided → Reset to 'prechecks' stage (preserve merge-fi if it succeeded)
3. `newPostchecks` provided → Reset to 'postchecks' stage (preserve all earlier phases)
4. `clearWorktree=true` → Full reset to 'merge-fi' stage
5. No changes → Resume from failed phase

**Updated Reset Logic**:
```typescript
if (options?.clearWorktree) {
  // Full reset
  nodeState.stepStatuses = undefined;
  nodeState.resumeFromPhase = undefined;
} else if (hasNewWork) {
  // Reset to work phase, preserve earlier successful phases
  if (nodeState.stepStatuses) {
    nodeState.stepStatuses.work = undefined;
    nodeState.stepStatuses.commit = undefined;
    nodeState.stepStatuses.postchecks = undefined;
    nodeState.stepStatuses['merge-ri'] = undefined;
  }
  nodeState.resumeFromPhase = 'work';
} else if (hasNewPrechecks) {
  // Reset to prechecks phase
  if (nodeState.stepStatuses) {
    nodeState.stepStatuses.prechecks = undefined;
    nodeState.stepStatuses.work = undefined;
    nodeState.stepStatuses.commit = undefined;
    nodeState.stepStatuses.postchecks = undefined;
    nodeState.stepStatuses['merge-ri'] = undefined;
  }
  nodeState.resumeFromPhase = 'prechecks';
} else if (hasNewPostchecks) {
  // Reset to postchecks phase
  if (nodeState.stepStatuses) {
    nodeState.stepStatuses.postchecks = undefined;
    nodeState.stepStatuses['merge-ri'] = undefined;
  }
  nodeState.resumeFromPhase = 'postchecks';
} else {
  // No changes - resume from failed phase
  nodeState.resumeFromPhase = failedPhase;
}
```

### 3. Enhanced Validation

Add validation to ensure:
- Cannot update `newWork` if node hasn't reached work phase yet
- Cannot update `newPostchecks` if node hasn't reached postchecks phase yet
- Warn user about phase implications when updating different specs

## Implementation Impact

### Files to Modify

1. **`src/mcp/tools/nodeTools.ts`**:
   - Add `newPrechecks` and `newPostchecks` parameters to `retry_copilot_node` tool schema

2. **`src/mcp/handlers/nodeHandlers.ts`**:
   - Update `handleRetryNode()` to pass new parameters to `PlanRunner.retryNode()`

3. **`src/plan/runner.ts`**:
   - Enhance phase reset logic in `retryNode()` method
   - Add smarter phase-specific reset behavior

### Backward Compatibility

✅ **Fully backward compatible** - existing calls will continue to work unchanged
- `newWork` parameter behavior remains the same for simple cases
- New parameters are optional
- Default behavior (no changes) remains unchanged

### Testing Requirements

1. **Phase Reset Tests**:
   - Test `newWork` resets to work phase
   - Test `newPrechecks` resets to prechecks phase  
   - Test `newPostchecks` resets to postchecks phase
   - Test `clearWorktree` does full reset

2. **Combined Update Tests**:
   - Test updating multiple specs simultaneously
   - Test edge cases (update work + postchecks, etc.)

3. **Resume Logic Tests**:
   - Verify successful phases are preserved
   - Verify failed phases are re-executed
   - Test execution flow after partial resets

## Benefits

1. **More Granular Control**: Users can update specific phases without resetting entire execution
2. **Efficiency**: Preserve successful work when only postchecks need updates
3. **Better User Experience**: Clear understanding of what phases will be re-executed
4. **Debugging**: Easier to iterate on specific failing phases