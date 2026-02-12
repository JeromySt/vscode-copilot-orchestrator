# Task: Integrate File Watcher with PlanRunner

## Overview
Add `OrchestratorFileWatcher` to `PlanRunner` to detect when plan files are externally deleted (e.g., by `git clean -dfx`) and update in-memory state accordingly.

## Changes Required

1. **Add import** for `OrchestratorFileWatcher` from `'../core'`
2. **Add private member** `_fileWatcher` to store the watcher instance
3. **Initialize in constructor** to watch for external plan deletions
4. **Add handler method** `_handleExternalPlanDeletion` to process deletion events
5. **Update disposal** to clean up the watcher
6. **Handle running plan cancellation** edge case with optional `skipPersist` parameter

## Key Considerations

- The file watcher needs the workspace path (parent of `.orchestrator/plans/`)
- Use `config.storagePath` which should be `.orchestrator` directory 
- Need to extract workspace path from `storagePath` (remove `/plans` suffix if present)
- Reuse existing `cancel()` method logic but avoid persistence since file is gone
- Fire `planDeleted` event to notify UI
- Show user notification about external deletion

## Implementation Status
- [x] Step 1: Add import
- [x] Step 2: Add private member
- [x] Step 3: Initialize in constructor  
- [x] Step 4: Add handler method
- [x] Step 5: Update disposal
- [x] Step 6: Handle cancellation edge case

## Changes Made

1. **Added import**: `import { OrchestratorFileWatcher } from '../core';`
2. **Added private member**: `private readonly _fileWatcher: OrchestratorFileWatcher;`
3. **Initialized in constructor**: 
   - Extract workspace path from `config.storagePath`
   - Create file watcher instance with deletion callback
4. **Added handler method**: `_handleExternalPlanDeletion()`
   - Check if plan exists in memory
   - Cancel running plan if needed (without persistence)
   - Remove from memory state
   - Fire `planDeleted` event
   - Show user notification
5. **Updated disposal**: Added `_fileWatcher.dispose()` to `shutdown()` method
6. **Updated cancel method**: Added optional `{ skipPersist?: boolean }` parameter

## Testing
- TypeScript compilation passes without errors
- All changes follow existing code patterns and conventions