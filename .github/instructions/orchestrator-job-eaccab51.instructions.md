---
applyTo: '.worktrees/eaccab51/**'
---

# Current Task

# Plan Detail: SubscribableControl Migration

## Current State
All 22 dynamic elements already use `bus.on(Topics.*)` but through ONE massive 200+ line `handleStatusUpdate()` function that does inline DOM manipulation. The EventBus is embedded. No SubscribableControl base class. No LayoutManager.

## APPROACH: Incremental refactoring (NOT full rewrite)
This file is 1012+ lines. Do NOT try to rewrite it all. Make targeted changes:

### Step 1: Read the entire file
Read `src/ui/templates/planDetail/scriptsTemplate.ts` completely. Understand the existing structure.

### Step 2: Add SubscribableControl base class (vanilla JS)
After the EventBus class (~line 84), add SubscribableControl as a vanilla JS constructor function (NOT TypeScript class). Use `var` everywhere. Include: subscribe(), subscribeToChild() with queueMicrotask debounce, publishUpdate(), unsubscribeAll(), getElement(), dispose().

### Step 3: Extract controls from handleStatusUpdate()
The existing `handleStatusUpdate()` does these groups of DOM updates. Extract each into a control:

**a) PlanStatusControl** — lines that update `.status-badge`, action buttons visibility
**b) ProgressControl** — lines that update `.progress-fill`, `.progress-text`  
**c) StatsControl** — lines that update `.stats .stat-value` elements
**d) MetricsBarControl** — lines that update `#planMetricsBar`
**e) LegendControl** — lines that update `.legend-item` counts
**f) CapacityInfoControl** — lines that update `#capacityInfo`, `#instanceCount`, etc.
**g) MermaidNodeStyleControl** — lines that update SVG node fill/stroke/icons (the big loop)
**h) MermaidEdgeStyleControl** — lines that update edge colors/dash/arrowheads
**i) MermaidGroupStyleControl** — lines that update cluster/subgraph colors/icons

Each control: `var X = new SubscribableControl(bus, 'x-id'); X.update = function(msg) { ... };`
Move the relevant DOM code from handleStatusUpdate INTO the control's update method.

**j) DurationCounterControl** — already partially done as `updateDurationCounter()`, convert to control
**k) NodeDurationControl** — already `updateNodeDurations()`, convert to control
**l) ProcessStatsControl** — already `renderAllProcesses()`, convert to control

### Step 4: Simplify handleStatusUpdate()
After extraction, it becomes:
```javascript
function handleStatusUpdate(msg) {
  // Store nodeData for controls to reference
  if (msg.nodeStatuses) {
    for (var id in msg.nodeStatuses) {
      nodeData[id] = Object.assign(nodeData[id] || {}, msg.nodeStatuses[id]);
    }
  }
  // Emit events - controls do the rest
  bus.emit(Topics.STATUS_UPDATE, msg);
}
```

### Step 5: Add LayoutManager
Create a LayoutManager control that:
- Listens for a new topic `layout:change`
- Debounces via requestAnimationFrame 
- Before mermaid.render(): saves `currentZoom`, `container.scrollTop`, `container.scrollLeft`
- Calls mermaid.render() with fresh definition
- After render: restores zoom, scroll, re-runs node color updates
- NodeDurationControl emits `layout:change` when text grows beyond SVG rect width

Also fix node label truncation: apply same foreignObject width expansion to nodes as currently done for clusters (lines 137-153).

### Step 6: Wire inner-out for groups
MermaidGroupStyleControl subscribes to child MermaidNodeStyleControl updates. When children update, group recalculates aggregate status.

## Key Rules
- Use `var`, not `const`/`let`
- No TypeScript syntax in embedded JS
- No ES module imports
- Keep all existing DOM selectors/IDs unchanged
- Visual behavior MUST be identical
- Test: `npx tsc --noEmit` must pass

## Read First
- `src/ui/templates/planDetail/scriptsTemplate.ts` (ENTIRE file)
- `src/ui/webview/subscribableControl.ts` (reference for the JS translation)
- `src/ui/webview/eventBus.ts` (already embedded, reference)
- `src/ui/webview/topics.ts`



## Guidelines

- Focus only on the task described above
- Make minimal, targeted changes
- Follow existing code patterns and conventions in this repository
- Commit your changes when complete
