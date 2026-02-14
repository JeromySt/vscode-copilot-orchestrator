---
applyTo: '.worktrees/c8be205e/**'
---

# Current Task

# Node Detail: SubscribableControl Migration

## Current State
9 dynamic elements use EventBus via inline `initStatusBadge()`, `initDurationCounter()`, `initLogViewer()`, `initProcessTree()` functions. These don't use SubscribableControl, don't call publishUpdate(). Missing: AttemptList, AiUsageStats, WorkSummary, ConfigDisplay.

## APPROACH: Incremental refactoring

### Step 1: Read the entire file
Read `src/ui/templates/nodeDetail/scriptsTemplate.ts` completely.

### Step 2: Add SubscribableControl base class (vanilla JS)
Same as plan detail — add after EventBus.

### Step 3: Convert existing inline controls
**a) StatusBadgeControl** — convert `initStatusBadge()` to SubscribableControl
**b) DurationCounterControl** — convert `initDurationCounter()`
**c) LogViewerControl** — convert `initLogViewer()`. Ensure incremental append (appendChild for new lines, not innerHTML for entire log). Auto-scroll only if at bottom.
**d) ProcessTreeControl** — convert `initProcessTree()`. Incremental row updates where possible.
**e) PhaseTabBarControl** — convert inline tab click handler. Subscribe to NODE_STATE_CHANGE to auto-show/hide tabs based on executed phases.

### Step 4: Add NEW controls
**f) AttemptListControl** — Dynamic attempt card management:
  - Subscribes to new `attempt:update` topic
  - Tracks existing attempt cards by number
  - When NEW attempt arrives: generate HTML, appendChild to container, create AttemptCardControl
  - Extension pushes full attempt list on state change
  
**g) AiUsageStatsControl** — Subscribes to `ai:usage` topic:
  - Updates model name, token counts (in/out/cached), premium requests, cost
  - Only visible for agent work nodes

**h) WorkSummaryControl** — Subscribes to `work:summary` topic:
  - Updates files added/modified/deleted, commit count
  - Shows after work phase completes

**i) ConfigDisplayControl** — Subscribes to `config:update` topic:
  - Shows prechecks (collapsible, collapsed default), work (always shown), postchecks (collapsible)
  - Auto-expands when that phase is currently executing
  - Respects user manual expand/collapse override
  - Phase type badge (shell/agent/process)
  - Live updates when update_copilot_plan_node changes spec

### Step 5: Extension-side changes
Update `src/ui/panels/nodeDetailPanel.ts` or `nodeDetailController.ts` to push new event types:
```typescript
postMessage({ type: 'attemptUpdate', attempts: [...] });
postMessage({ type: 'aiUsageUpdate', metrics: {...} });
postMessage({ type: 'workSummary', summary: {...} });
postMessage({ type: 'configUpdate', data: { work, prechecks, postchecks, currentPhase } });
```

### Step 6: Route new messages to EventBus in webview

## Key Rules
- Use `var`, no TypeScript, no imports
- Visual behavior identical
- LogViewer: never replace existing log lines
- AttemptList: handle dynamic creation for retries
- ConfigDisplay: collapsible prechecks/postchecks, auto-expand when running



## Guidelines

- Focus only on the task described above
- Make minimal, targeted changes
- Follow existing code patterns and conventions in this repository
- Commit your changes when complete
