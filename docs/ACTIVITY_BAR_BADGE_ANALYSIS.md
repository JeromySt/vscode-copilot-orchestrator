# VS Code Activity Bar Badge API Analysis

## Overview

This document analyzes the requirements and implementation options for adding a badge (number indicator) to the Copilot Orchestrator icon in the VS Code activity bar, showing the count of currently running plans.

## Current Tree View Registration

### Location and Implementation
- **Registration Code**: `src/core/planInitialization.ts:355-358`
```typescript
context.subscriptions.push(
  vscode.window.registerWebviewViewProvider('orchestrator.plansView', plansView)
);
```

- **View Definition**: `package.json` contributes section:
```json
"views": {
  "copilot-orchestrator": [
    {
      "id": "orchestrator.plansView", 
      "name": "Plans",
      "type": "webview"
    }
  ]
}
```

- **Provider Class**: `plansViewProvider` in `src/ui/plansViewProvider.ts`
- **Interface**: Implements `vscode.WebviewViewProvider`, NOT `vscode.TreeDataProvider`

### Current Architecture
The current implementation uses a **WebviewViewProvider** instead of a traditional TreeView:
- Custom HTML/CSS/JS interface
- Rich formatting and interactive elements
- Real-time updates via webview messaging
- Keyboard shortcuts and custom styling

## VS Code Badge API Research

### Badge API Availability
The VS Code badge API has a critical limitation:

```typescript
// ✅ Available on TreeView
interface TreeView<T> {
  badge?: ViewBadge | undefined;
}

interface ViewBadge {
  tooltip: string;
  value: number;
}

// ❌ NOT available on WebviewView  
interface WebviewView {
  // No badge property exists!
}
```

### Badge Usage Pattern
For TreeView implementations:
```typescript
// Set badge
treeView.badge = { value: 3, tooltip: '3 running plans' };

// Clear badge  
treeView.badge = undefined;
```

## Plan Status Tracking

### Running Plan Count Source
The count of running plans can be obtained from:

**Method**: `PlanRunner.getGlobalStats()` in `src/plan/runner.ts:632-655`
```typescript
getGlobalStats(): {
  running: number;    // Number of running job nodes
  maxParallel: number;
  queued: number;
} 
```

**Alternative**: Count plans directly by status
```typescript
// Count plans with 'running' status
let runningPlans = 0;
for (const [planId, plan] of this.plans) {
  const sm = this.stateMachines.get(planId);
  if (sm?.computePlanStatus() === 'running') {
    runningPlans++;
  }
}
```

### Plan Status Calculation
- **Status Computation**: `StateMachine.computePlanStatus()` in `src/plan/stateMachine.ts:470`
- **Helper Function**: Uses `computePlanStatusHelper()` from `src/plan/helpers.ts`
- **Running Criteria**: Plan has at least one node in 'running' or 'scheduled' status and is not paused

### Badge Update Events
Badge should update when these events occur:

1. **Plan Lifecycle Events** (emitted by PlanRunner):
   - `planCreated` - New plan added
   - `planStarted` - Plan begins execution  
   - `planCompleted` - Plan finishes (success/failure)
   - `planDeleted` - Plan removed

2. **Node Transition Events**:
   - `nodeTransition` - Node status changes (includes running ↔ other states)

3. **Plan State Changes**:
   - Pause/Resume operations
   - Manual cancellation

## Implementation Options

### Option A: Convert to TreeView (Recommended)

**Approach**: Convert from WebviewViewProvider to TreeDataProvider
- **Access**: Gain native `badge` property support
- **Benefits**: 
  - True VS Code integration
  - Better performance
  - Native keyboard navigation
  - Consistent VS Code UX
- **Challenges**:
  - Significant refactoring required
  - Loss of current rich HTML formatting
  - Need to recreate interactive features using TreeItem APIs

### Option B: Keep WebviewView + Custom Badge

**Approach**: Add HTML-based badge indicator in webview header
- **Implementation**: Update webview HTML to show count in header
- **Benefits**:
  - No architectural changes
  - Quick to implement
- **Limitations**:
  - Not a true activity bar badge
  - Less integrated user experience
  - Badge only visible when view is open

### Option C: Hybrid Approach  

**Approach**: Add minimal TreeView alongside existing WebviewView
- **Structure**: 
  - Keep existing webview for rich plan management
  - Add simple TreeView purely for badge functionality
- **Benefits**:
  - Minimal code changes
  - True badge support
  - Preserve existing functionality
- **Drawbacks**:
  - Two views for one feature
  - Potential user confusion
  - Redundant data management

## Recommended Implementation

### Phase 1: Plan Counter Implementation
Create utility to count running plans:

```typescript
// In PlanRunner class
getRunningPlanCount(): number {
  let count = 0;
  for (const [planId, plan] of this.plans) {
    const sm = this.stateMachines.get(planId);
    if (sm?.computePlanStatus() === 'running') {
      count++;
    }
  }
  return count;
}
```

### Phase 2: TreeView Conversion Analysis
Research impact of converting to TreeView:
1. Catalog current webview features
2. Map to TreeItem capabilities  
3. Prototype basic TreeView implementation
4. Test badge functionality

### Phase 3: Implementation Decision
Based on Phase 2 findings:
- **If TreeView viable**: Full conversion with badge support
- **If TreeView limiting**: Implement Option C (hybrid) or Option B (custom badge)

## Badge Update Logic

### Event Handling Pattern
```typescript
class BadgeAwareTreeView {
  private updateBadge() {
    const runningCount = this.planRunner.getRunningPlanCount();
    
    if (runningCount > 0) {
      this.treeView.badge = {
        value: runningCount,
        tooltip: `${runningCount} running plan${runningCount === 1 ? '' : 's'}`
      };
    } else {
      this.treeView.badge = undefined;
    }
  }
  
  private setupEventHandlers() {
    this.planRunner.on('planCreated', () => this.updateBadge());
    this.planRunner.on('planCompleted', () => this.updateBadge()); 
    this.planRunner.on('planDeleted', () => this.updateBadge());
    this.planRunner.on('nodeTransition', () => this.updateBadge());
  }
}
```

### Performance Considerations
- Badge updates should be throttled/debounced for rapid node transitions
- Consider caching running count and only recalculating on relevant events
- Current webview already uses 100ms debounce for `nodeTransition` events

## Conclusion

The key finding is that **VS Code badges are only available on TreeView, not WebviewView**. This creates a fundamental architectural decision:

1. **For true badge integration**: Convert to TreeView (significant effort, full feature parity needs verification)
2. **For quick implementation**: Use custom HTML badge or hybrid approach
3. **For best UX**: Likely TreeView conversion, pending feature analysis

The next step should be prototyping a TreeView implementation to assess feasibility while implementing the running plan counter logic regardless of the final UI approach.