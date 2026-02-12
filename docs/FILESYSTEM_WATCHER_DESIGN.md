# Filesystem Watcher Design for .orchestrator Directory

## Overview

This document describes the design for a filesystem watcher that monitors the `.orchestrator/plans/` directory to synchronize in-memory plan state when files are externally deleted, ensuring consistency between the filesystem and the PlanRunner's internal state.

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   PlanRunner                         │
│  ┌─────────────────────────────────────────────┐    │
│  │         OrchestratorFileWatcher             │    │
│  │  - watches: .orchestrator/plans/*.json      │    │
│  │  - events: onDidDelete, onDidCreate         │    │
│  │  - debounces rapid events (100ms)           │    │
│  └─────────────────────────────────────────────┘    │
│                      │                               │
│                      ▼                               │
│  ┌─────────────────────────────────────────────┐    │
│  │     In-Memory State (this.plans Map)        │    │
│  │  - synchronized on file deletion            │    │
│  │  - fires onPlanDeleted event                │    │
│  │  - cancels running nodes if needed          │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

## Context

The PlanRunner maintains an in-memory `plans` Map (line 255 in `src/plan/runner.ts`) that tracks active plan instances. Plan files are persisted to `{workspace}/.orchestrator/plans/plan-{id}.json` via the PlanPersistence class. When external tools or users manually delete plan files, the in-memory state becomes inconsistent, potentially causing:

1. Memory leaks (deleted plans remain in memory)
2. UI inconsistencies (plans show as active when files don't exist)
3. Resource leaks (running jobs for deleted plans)

## Events to Watch

| Event | File Pattern | Action |
|-------|-------------|--------|
| `onDidDelete` | `**/.orchestrator/plans/*.json` | Extract plan ID from filename, remove from `this.plans` Map, fire `onPlanDeleted` event, cancel running nodes |
| `onDidCreate` | `**/.orchestrator/plans/*.json` | Optional: Could reload plan if created externally (future enhancement) |
| `onDidChange` | `**/.orchestrator/plans/*.json` | Optional: Could reload plan if modified externally (future enhancement) |

## Implementation Strategy

### Core Components

#### 1. OrchestratorFileWatcher Class

```typescript
import * as vscode from 'vscode';
import * as path from 'path';

interface FileWatcherCallbacks {
  onPlanFileDeleted: (planId: string) => void;
}

class OrchestratorFileWatcher implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | undefined;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly DEBOUNCE_MS = 100;

  constructor(
    private readonly workspacePath: string,
    private readonly callbacks: FileWatcherCallbacks
  ) {
    this.initialize();
  }

  private initialize(): void {
    // Watch pattern: **/.orchestrator/plans/*.json
    const pattern = new vscode.RelativePattern(
      this.workspacePath,
      '**/.orchestrator/plans/*.json'
    );
    
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    
    // Only handle deletions initially
    this.watcher.onDidDelete(this.onFileDeleted.bind(this));
  }

  private onFileDeleted(uri: vscode.Uri): void {
    const filename = path.basename(uri.fsPath);
    
    // Extract plan ID from filename pattern: plan-{uuid}.json
    if (!filename.startsWith('plan-') || !filename.endsWith('.json')) {
      return;
    }
    
    const planId = filename.slice(5, -5); // Remove 'plan-' prefix and '.json' suffix
    
    // Debounce rapid events
    this.debounceCallback(planId, () => {
      this.callbacks.onPlanFileDeleted(planId);
    });
  }

  private debounceCallback(key: string, callback: () => void): void {
    // Clear existing timer
    const existingTimer = this.debounceTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    
    // Set new timer
    const timer = setTimeout(() => {
      callback();
      this.debounceTimers.delete(key);
    }, this.DEBOUNCE_MS);
    
    this.debounceTimers.set(key, timer);
  }

  dispose(): void {
    // Clear all pending timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    
    // Dispose watcher
    this.watcher?.dispose();
    this.watcher = undefined;
  }
}
```

#### 2. Integration with PlanRunner

Modify `src/plan/runner.ts` to integrate the file watcher:

```typescript
export class PlanRunner extends EventEmitter {
  private plans = new Map<string, PlanInstance>();
  private fileWatcher: OrchestratorFileWatcher | undefined;
  // ... existing fields

  constructor(config: PlanRunnerConfig) {
    super();
    this.config = config;
    // ... existing initialization
    
    // Initialize file watcher if we have a workspace path
    if (config.defaultRepoPath) {
      this.fileWatcher = new OrchestratorFileWatcher(
        config.defaultRepoPath,
        {
          onPlanFileDeleted: this.handlePlanFileDeleted.bind(this)
        }
      );
    }
  }

  private handlePlanFileDeleted(planId: string): void {
    const plan = this.plans.get(planId);
    if (!plan) {
      // Plan not in memory - nothing to do
      return;
    }

    this.log.info(`Plan file deleted externally, syncing in-memory state`, { planId });

    // Cancel any running nodes for this plan
    this.cancelPlanExecution(planId).catch(err => {
      this.log.error(`Failed to cancel plan execution during file deletion sync`, { 
        planId, 
        error: err.message 
      });
    });

    // Remove from memory
    this.plans.delete(planId);
    this.stateMachines.delete(planId);

    // Fire event for UI updates
    this.emit('planDeleted', planId, plan);

    // Note: We don't call persistence.delete() since the file is already gone
  }

  // ... existing methods

  dispose(): void {
    // ... existing disposal logic
    
    // Dispose file watcher
    this.fileWatcher?.dispose();
    this.fileWatcher = undefined;
  }
}
```

### File Pattern Matching

The file watcher uses the glob pattern `**/.orchestrator/plans/*.json` which:
- `**` matches any directory depth (handles different workspace structures)
- `.orchestrator/plans/` targets the specific directory
- `*.json` matches plan files (pattern: `plan-{uuid}.json`)

### Plan ID Extraction

Plan IDs are extracted from filenames using the pattern:
- Filename: `plan-{uuid}.json`
- Extraction: `filename.slice(5, -5)` removes 'plan-' prefix and '.json' suffix
- Validation: Check filename starts with 'plan-' and ends with '.json'

### Event Debouncing

Rapid file system events (e.g., during batch deletions) are debounced with a 100ms delay to:
- Reduce unnecessary processing
- Handle file system quirks (some operations trigger multiple events)
- Improve performance during bulk operations

## Edge Cases

### 1. Entire `.orchestrator/` Directory Deleted

**Scenario**: User or external tool deletes the entire `.orchestrator/` directory.

**Behavior**: 
- File watcher will fire deletion events for all `*.json` files in the plans subdirectory
- Each deletion will be processed individually via `handlePlanFileDeleted()`
- All in-memory plans will be removed and their executions cancelled

**Handling**: No special case needed - existing deletion handling covers this scenario.

### 2. Plan Deleted While Node is Running

**Scenario**: Plan file deleted while one or more nodes are actively executing.

**Behavior**:
- `handlePlanFileDeleted()` calls `cancelPlanExecution()` to gracefully stop running nodes
- Existing cancellation logic handles stopping agents and cleaning up resources
- Plan state transitions to cancelled/stopped

**Handling**: Leverage existing `cancelPlanExecution()` method for consistent behavior.

### 3. File Renamed (Shows as Delete + Create)

**Scenario**: Plan file is renamed (e.g., from `plan-abc.json` to `plan-def.json`).

**Behavior**:
- File system reports this as delete event for old name, create event for new name
- Delete event removes plan from memory (assuming plan ID 'abc' doesn't match 'def')
- Create event could potentially reload plan with new ID (future enhancement)

**Handling**: Treat as separate delete/create events. Current scope only handles deletions.

### 4. VS Code Reload While Plan is Active

**Scenario**: VS Code is reloaded/restarted while plans are running.

**Behavior**:
- Extension deactivation disposes file watcher cleanly
- Extension reactivation recreates file watcher 
- Running plans are restored from persistence during PlanRunner initialization
- File watcher resumes monitoring

**Handling**: No special handling needed - existing persistence and initialization covers this.

### 5. File Temporarily Unavailable

**Scenario**: File becomes temporarily unavailable (e.g., during antivirus scan, backup operations).

**Behavior**:
- VS Code's FileSystemWatcher might fire spurious events
- Debouncing helps filter rapid event sequences
- Only actual deletions should trigger plan removal

**Handling**: Debouncing provides protection against temporary unavailability.

## Performance Considerations

### Minimal Scope
- Watcher targets specific directory pattern: `**/.orchestrator/plans/*.json`
- Does not watch entire workspace, only relevant subdirectories
- Minimal performance impact compared to broad workspace watching

### Efficient Processing
- Plan ID extraction is O(1) string operation
- Map lookups for plan existence are O(1)
- Debouncing prevents excessive processing during batch operations

### Memory Usage
- Debounce timers map has minimal overhead (one timeout per plan ID)
- File watcher uses VS Code's native implementation (efficient)
- No additional persistent storage required

## Integration Points

### PlanRunner Events

New event emitted by PlanRunner:
- `planDeleted(planId: string, plan: PlanInstance)` - Fired when a plan is removed due to file deletion

### Extension Lifecycle

File watcher integration with VS Code extension lifecycle:
- **Activation**: File watcher created during PlanRunner initialization (`src/core/planInitialization.ts`)
- **Deactivation**: File watcher disposed during extension deactivation (`src/extension.ts`)

### Error Handling

Errors in file watcher operations should be:
- Logged via the PlanRunner's logger
- Non-fatal (don't crash the extension)
- Include context (plan ID, file path, operation)

## Configuration

### Environment-Specific Behavior
- **With Workspace**: Watch `{workspace}/.orchestrator/plans/*.json`
- **Without Workspace**: Watch `{globalStorage}/plans/*.json`
- **Worktree Context**: Watch within current worktree's .orchestrator directory

### Configurable Options (Future)
Could be extended with configuration options:
- `fileWatcher.enabled` - Enable/disable file watching
- `fileWatcher.debounceMs` - Adjust debounce timing
- `fileWatcher.watchCreate` - Enable watching for file creation
- `fileWatcher.watchModify` - Enable watching for file modifications

## Testing Strategy

### Unit Tests
- Plan ID extraction from various filename patterns
- Debounce timing behavior
- Event handler registration/deregistration
- Disposal cleanup

### Integration Tests  
- File deletion triggers in-memory plan removal
- Multiple rapid deletions are handled correctly
- Plan execution cancellation on file deletion
- Error scenarios (invalid filenames, missing plans)

### Manual Testing
- Delete plan files externally via file explorer
- Delete entire `.orchestrator/plans/` directory
- Rename plan files
- Bulk delete operations
- VS Code reload scenarios

## Future Enhancements

### File Creation Monitoring
Monitor for externally created plan files and reload them:
```typescript
private onFileCreated(uri: vscode.Uri): void {
  const planId = this.extractPlanId(uri);
  if (planId && !this.plans.has(planId)) {
    this.loadPlanFromFile(planId);
  }
}
```

### File Modification Monitoring  
Detect external modifications and reload plan state:
```typescript
private onFileModified(uri: vscode.Uri): void {
  const planId = this.extractPlanId(uri);
  if (planId && this.plans.has(planId)) {
    this.reloadPlanFromFile(planId);
  }
}
```

### Smart Conflict Resolution
Handle concurrent modifications between in-memory state and file system:
- Timestamp comparison
- User prompts for conflict resolution
- Merge strategies for compatible changes

## Conclusion

The OrchestratorFileWatcher provides a robust solution for synchronizing in-memory plan state with filesystem changes. The design focuses on:

1. **Reliability**: Handles edge cases and error scenarios gracefully
2. **Performance**: Minimal overhead with targeted watching and efficient processing  
3. **Consistency**: Maintains synchronization between filesystem and memory
4. **Extensibility**: Foundation for future enhancements (create/modify monitoring)

The implementation integrates seamlessly with the existing PlanRunner architecture while providing the foundation for more advanced file synchronization capabilities in the future.