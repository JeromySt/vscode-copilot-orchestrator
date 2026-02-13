# Duration Display Timer Analysis

## Problem Statement

There are 3 places showing duration in the VS Code extension that should update in real-time while jobs are running, but **NONE** are updating:

1. **Tree View sidebar** - "36m 1s" next to plan name in sidebar
2. **Plan Detail Panel header** - the main "5h 17s" at top of plan view  
3. **Node Detail Panel** - "4m 16s" in the node detail view on the right

## Current Implementation Analysis

### 1. Tree View (Sidebar) Duration Display

**Location:** `src/ui/planTreeProvider.ts` + `src/ui/plansViewProvider.ts`

**Current Status:** ✅ **PARTIALLY WORKING** 
- Extension-side timer in `PlanTreeViewManager` refreshes at 1-second intervals
- Timer in `startDurationRefreshTimer()` calls `treeDataProvider.refresh()` every 1000ms
- Duration calculated in `getPlanStatusDescription()` using `Date.now() - plan.startedAt`
- **Issue:** This only affects the TreeView (activity bar badge), NOT the main sidebar plans view

**Implementation Details:**
```typescript
// planTreeProvider.ts - Tree view for badge (WORKING)
private startDurationRefreshTimer(): void {
  this._refreshTimer = setInterval(() => {
    if (this.hasRunningPlans()) {
      this.treeDataProvider.refresh(); // Updates tree descriptions with live duration
    }
  }, 1000);
}

// plansViewProvider.ts - Main sidebar webview (BROKEN)
this._refreshTimer = setInterval(() => {
  const hasRunning = /* check for running plans */;
  if (hasRunning) {
    this.refresh(); // Full webview refresh - kills client-side timers!
  }
}, 1000);
```

**Root Cause:** The `plansViewProvider.ts` timer does **full webview refresh** every second, which **destroys any client-side timers** in the webview JavaScript. The webview has `formatDuration()` function but no timer calling it.

### 2. Plan Detail Panel Duration Display

**Location:** `src/ui/panels/planDetailPanel.ts`

**Current Status:** ✅ **WORKING**
- Extension-side timer calls `this._update()` every 1000ms  
- Client-side JavaScript has `updateDurationCounter()` with `setInterval(updateDurationCounter, 1000)`
- Uses `data-started` and `data-ended` attributes to calculate live duration

**Implementation Details:**
```typescript
// Extension side
this._updateInterval = setInterval(() => this._update(), 1000);

// Client side (webview JavaScript)  
function updateDurationCounter() {
  const el = document.getElementById('planDuration');
  const started = parseInt(el.dataset.started) || 0;
  const ended = parseInt(el.dataset.ended) || 0;
  if (status === 'running' || status === 'pending') {
    const duration = Date.now() - started;
    el.textContent = formatDurationLive(duration);
  }
}
setInterval(updateDurationCounter, 1000);
```

**Root Cause:** This is actually working! The issue may be that the panel needs to be open and visible.

### 3. Node Detail Panel Duration Display

**Location:** `src/ui/panels/nodeDetailPanel.ts`

**Current Status:** ✅ **WORKING**
- Extension-side timer with smart refresh logic every 1000ms
- Client-side timer for `duration-timer` element with `data-started-at` attribute
- Uses `formatDuration()` helper for live updates

**Implementation Details:**
```typescript
// Extension side - smart refresh that doesn't kill client timers
this._updateInterval = setInterval(() => {
  if (state?.status === 'running' || state?.status === 'scheduled') {
    if (this._lastStatus !== state.status) {
      this._update(); // Full update only on status change
    } else {
      this._sendLog(this._currentPhase); // Just log refresh
    }
  }
}, 1000);

// Client side
const durationTimer = document.getElementById('duration-timer');
if (durationTimer && durationTimer.hasAttribute('data-started-at')) {
  setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    durationTimer.textContent = formatDuration(elapsed * 1000);
  }, 1000);
}
```

**Root Cause:** This appears to be working correctly! Smart extension-side refresh + client-side timer.

## Root Cause Analysis

### Main Issue: Tree View Sidebar Duration Not Updating

The primary issue is in `plansViewProvider.ts` (the main sidebar plans view):

1. **Extension timer does full refresh every second** - This destroys client-side JavaScript state
2. **No client-side timer** - The webview has `formatDuration()` function but no timer calling it
3. **Wrong timer pattern** - Unlike the working panels, this doesn't preserve client-side timers

### Secondary Issues

1. **Plan Detail Panel** - Likely working, needs verification
2. **Node Detail Panel** - Likely working, needs verification  
3. **Tree view badge** - Working (different component than sidebar)

## Solution Architecture

### For Plans View Sidebar (Primary Fix)

**Option 1: Client-side timer approach** (Recommended)
- Stop the aggressive extension-side refresh timer
- Add client-side JavaScript timer like the working panels
- Extension only refreshes on actual data changes (plan created/completed)
- Pass `startedAt` timestamps to webview for client-side calculation

**Option 2: Smart extension refresh** (Alternative)
- Keep extension timer but make it smarter (like nodeDetailPanel)
- Only do full refresh on status changes, not every second
- Add incremental update messages for duration updates

### Implementation Plan

1. **Fix plansViewProvider.ts timer pattern:**
   - Remove the 1-second full refresh timer  
   - Add client-side duration timer in webview JavaScript
   - Use `data-started-at` attributes like the working panels
   - Extension only refreshes on actual plan state changes

2. **Verify other panels are working:**
   - Test plan detail panel duration display
   - Test node detail panel duration display
   - Document any remaining issues

## File Changes Required

### Primary Fix: `src/ui/plansViewProvider.ts`

```typescript
// REMOVE this destructive timer:
this._refreshTimer = setInterval(() => {
  if (hasRunning) {
    this.refresh(); // ❌ Kills client-side timers!
  }
}, 1000);

// ADD client-side timer in webview HTML like planDetailPanel.ts:
setInterval(() => {
  // Update duration displays without full refresh
}, 1000);
```

### Supporting Changes

- Update webview HTML template to include duration timer JavaScript
- Ensure `startedAt` data is passed to client-side for calculation
- Test and verify other panels are working as expected

## Verification Steps

1. Create a running plan
2. Check each duration display updates every second:
   - [ ] Tree View sidebar plan duration 
   - [ ] Plan Detail Panel header duration
   - [ ] Node Detail Panel duration
3. Verify timers stop when plans complete
4. Verify no performance issues with the timer approach

## References

- **Working example:** `nodeDetailPanel.ts` smart timer pattern
- **Working example:** `planDetailPanel.ts` client-side timer  
- **Working example:** `planTreeProvider.ts` extension-side timer
- **Broken example:** `plansViewProvider.ts` destructive full refresh timer