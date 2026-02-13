# Task: Wire Sidebar, TreeView & StatusBar - Remove setInterval

## Analysis

The task is to remove 1000ms setInterval calls from the three main UI components and ensure they use PulseEmitter instead.

### Current State
- **plansViewProvider.ts**: Already uses PulseEmitter correctly (line 128-138). No setInterval found.
- **planTreeProvider.ts**: Already uses PulseEmitter correctly (line 169-173). Has unused `DURATION_REFRESH_INTERVAL = 1000` constant that should be removed.
- **statusBar.ts**: Already uses PulseEmitter correctly (line 38-71). No setInterval found.

### Webview setInterval calls
The grep results show setInterval calls in webview templates:
- `src\ui\templates\planDetail\scriptsTemplate.ts`: Multiple setInterval calls (lines 385, 459, etc.)
- `src\ui\templates\nodeDetail\scriptsTemplate.ts`: setInterval calls (lines 360, 378)

**Important**: These webview setInterval calls should remain because:
1. Webviews run in a separate browser context
2. They don't have access to VS Code extension APIs or PulseEmitter
3. They need their own timers for updating duration displays

### Required Changes
1. Remove unused `DURATION_REFRESH_INTERVAL` constant from planTreeProvider.ts
2. Verify no other setInterval usage in main extension code

### Verification
After changes, run grep to confirm ZERO setInterval in extension except:
- PulseEmitter implementation itself
- Webview template scripts (which must remain)
- Global capacity and execution pump (which are legitimate)