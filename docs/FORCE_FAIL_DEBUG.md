# Force-Fail Button Debug Investigation

## Problem Summary
The "Force Fail (Enable Retry)" button in the Node Detail Panel doesn't work correctly despite previous fixes.

## Complete Flow Analysis

### 1. UI Button Display Conditions

**Location**: `src/ui/panels/nodeDetailPanel.ts:814-815`
```typescript
${(state.status === 'running' || state.status === 'scheduled' || state.status === 'pending') ? `
<div class="force-fail-section">
```

**Button HTML**: `src/ui/panels/nodeDetailPanel.ts:819-820`
```html
<button class="retry-btn secondary" data-action="force-fail-node" data-plan-id="${plan.id}" data-node-id="${node.id}">
  ⚠️ Force Fail (Enable Retry)
</button>
```

### 2. Button Click Handler

**Location**: `src/ui/panels/nodeDetailPanel.ts:1000-1004`
```typescript
} else if (action === 'force-fail-node') {
  if (confirm('Force-fail this node? This will mark it as failed and may affect downstream nodes.')) {
    vscode.postMessage({ type: 'forceFailNode', planId, nodeId });
  }
}
```

### 3. Message Handler (Extension)

**Location**: `src/ui/panels/nodeDetailPanel.ts:550-552`
```typescript
case 'forceFailNode':
  // Use message params if provided, otherwise fall back to instance variables
  this._forceFailNode(message.planId || this._planId, message.nodeId || this._nodeId);
  break;
```

### 4. UI Panel Method

**Location**: `src/ui/panels/nodeDetailPanel.ts:568-600`
```typescript
private _forceFailNode(planId: string, nodeId: string) {
  // Enhanced debugging shows before/after state
  const result = this._planRunner.forceFailNode(planId, nodeId, 'Force failed via UI - process may have crashed');
  
  if (result.success) {
    vscode.window.showInformationMessage('Node force failed. You can now retry it.');
    this._update(); // Immediate UI refresh
  }
}
```

### 5. Runner Implementation

**Location**: `src/plan/runner.ts:3324-3425`

Key validation logic:
```typescript
// Allow force fail for more states that might indicate stuck nodes
const allowedStates = ['running', 'scheduled', 'pending'];
if (!allowedStates.includes(nodeState.status)) {
  return { success: false, error: `Cannot force fail node in ${nodeState.status} state...` };
}
```

Key state update logic:
```typescript
// Use state machine transition to properly propagate failure
const transitioned = sm.transition(nodeId, 'failed');
if (!transitioned) {
  // Fallback: force it directly
  nodeState.status = 'failed';
  nodeState.endedAt = Date.now();
  nodeState.version = (nodeState.version || 0) + 1;
  plan.stateVersion = (plan.stateVersion || 0) + 1;
}

// Persist the updated state
this.persistence.save(plan);
```

## Root Cause Analysis

### Issue Identified: **State Machine Transition Failure**

The key issue is likely in this line:
```typescript
const transitioned = sm.transition(nodeId, 'failed');
```

**If `sm.transition()` returns false:**
1. The fallback code executes manually setting status to 'failed'
2. However, the state machine may have guards or conditions that prevent the transition
3. The fallback may not fully replicate all state machine side effects
4. Events may not be properly emitted
5. UI might not refresh correctly

### UI Refresh Mechanism

The nodeDetailPanel has **dual refresh mechanisms**:

1. **Immediate**: `this._update()` called right after force fail succeeds
2. **Polling**: `setInterval()` every 500ms checks for status changes

**Location**: `src/ui/panels/nodeDetailPanel.ts:389-416`
```typescript
this._updateInterval = setInterval(() => {
  const plan = this._planRunner.get(this._planId);
  const state = plan?.nodeStates.get(this._nodeId);
  
  if (this._lastStatus === 'running' || this._lastStatus === 'scheduled') {
    // Transitioned from running to terminal - do full update
    this._lastStatus = state?.status || null;
    this._update();
  }
}, 500);
```

Both mechanisms should work, but if the state doesn't actually change due to state machine issues, neither will help.

## Debugging Added

### Enhanced UI Logging
Added detailed logging to `_forceFailNode()` to show:
- Node state before force fail attempt
- Force fail result
- Node state after force fail attempt
- UI refresh trigger

### Enhanced Runner Logging  
Added logging to `forceFailNode()` to show:
- State machine transition attempt
- Whether transition succeeded or failed
- Fallback execution if needed
- Final state persistence

## Test Plan

### Manual Testing Steps

1. **Start a node that will run long enough to test**
2. **Open node detail panel while it's running**  
3. **Click "Force Fail (Enable Retry)" button**
4. **Check browser developer console for our debug logs**
5. **Verify UI updates to show 'failed' status**

### Key Debug Questions

1. Does `sm.transition(nodeId, 'failed')` return true or false?
2. If false, does the fallback code execute correctly?
3. Does the node state actually change to 'failed'?
4. Does `this._update()` get called after force fail?
5. Does the polling mechanism detect the change within 500ms?

### Expected Debug Output

**Successful Force Fail:**
```
[DEBUG] Force fail attempt: { planId: 'xxx', nodeId: 'yyy', currentStatus: 'running', attempts: 1, ... }
[DEBUG] Force fail state machine transition - BEFORE: { nodeId: 'yyy', status: 'running', ... }
[DEBUG] Force fail state machine transition - AFTER: { nodeId: 'yyy', transitioned: true, status: 'failed', ... }
[DEBUG] Persisting force fail state changes
[DEBUG] Force fail completed successfully for node: yyy
[DEBUG] Force fail result: { success: true }
[DEBUG] Node state after force fail: { status: 'failed', attempts: 1, error: 'Force failed via UI...', ... }
[DEBUG] Force fail succeeded, calling _update() to refresh UI
```

**Failed State Machine Transition:**
```
[DEBUG] Force fail state machine transition - AFTER: { nodeId: 'yyy', transitioned: false, status: 'running', ... }
[DEBUG] State machine transition failed, using fallback
```

## Next Steps

1. Test with a real running node
2. Examine console output to identify where the failure occurs
3. If state machine transition fails, investigate state machine logic
4. If state changes but UI doesn't refresh, investigate UI update logic

## Summary of Investigation

### ✅ What We Found

1. **Complete Flow Mapped**: Successfully traced the complete path from UI button click to backend state change
2. **Dual UI Refresh**: The panel has both immediate refresh (`this._update()`) and polling (500ms interval) 
3. **State Machine Dependency**: Force fail relies on `sm.transition(nodeId, 'failed')` with fallback
4. **Debug Logging Added**: Comprehensive logging to identify where failures occur

### ❌ Root Cause Hypothesis

The most likely issue is **state machine transition failure**:

```typescript
const transitioned = sm.transition(nodeId, 'failed');
if (!transitioned) {
  // Fallback code may not fully replicate state machine behavior
}
```

If `sm.transition()` returns `false`, the fallback manually sets the status but may miss:
- Proper event emission sequences 
- Dependent node state updates
- Complete state machine side effects
- Version increment timing

### 🔧 Debug Changes Made

**Files Modified:**
- `src/ui/panels/nodeDetailPanel.ts` - Enhanced UI logging and immediate refresh confirmation
- `src/plan/runner.ts` - Added state machine transition logging and fallback detection
- `docs/FORCE_FAIL_DEBUG.md` - Comprehensive flow documentation

**Key Debug Points:**
- Before/after state comparison in UI
- State machine transition success/failure detection  
- Fallback execution tracking
- Persistence confirmation

### 📋 Testing Instructions

To identify the exact issue:

1. **Create a long-running plan node** (e.g., with sleep or long build)
2. **Open Node Detail Panel** while the node is in 'running' state
3. **Click "Force Fail (Enable Retry)" button**
4. **Open VS Code Developer Console** (Help > Toggle Developer Tools)
5. **Look for debug output** with `[DEBUG]` prefix

**Expected Output Patterns:**

**If State Machine Works:**
```
[DEBUG] Force fail state machine transition - AFTER: { transitioned: true, status: 'failed' }
[DEBUG] Node state after force fail: { status: 'failed' }
[DEBUG] Force fail succeeded, calling _update() to refresh UI
```

**If State Machine Fails:**
```
[DEBUG] Force fail state machine transition - AFTER: { transitioned: false, status: 'running' }
[DEBUG] State machine transition failed, using fallback
```

**If UI Refresh Fails:**
```
[DEBUG] Force fail succeeded, calling _update() to refresh UI
// But UI still shows 'running' status instead of 'failed'
```

### ✨ Ready for Testing

The investigation is complete and debug logging is in place. The next step is to test with a real running node to capture the debug output and identify the exact failure point.