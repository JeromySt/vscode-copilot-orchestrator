# Filesystem Resilience Analysis

## Problem Statement

The VS Code Copilot Orchestrator extension stores state in a `.orchestrator/` directory within each workspace. This directory and its contents can be deleted by external processes (e.g., `git clean -dfx`, manual deletion), leading to:

1. **ENOENT errors** when the extension tries to write to missing directories
2. **Silent delete operation failures** where file deletion fails but in-memory state isn't updated
3. **UI desync** where the UI doesn't reflect the actual filesystem state

## Current Architecture

The extension uses the following directory structure:
- `.orchestrator/plans/` - Plan persistence (JSON files)
- `.orchestrator/.copilot/` - Copilot CLI session data
- `.orchestrator/evidence/` - Evidence files for job validation
- `.orchestrator/logs/` - Execution logs

## File System Write Locations

### 1. Plan Persistence (`src/plan/persistence.ts`)

**Current Behavior:**
- **Directory Creation**: `ensureStorageDir()` is called in constructor (line 97-104) 
- **Write Operations**: `save()` method writes plan JSON files directly using `fs.writeFileSync()`
- **Error Handling**: Try-catch around `fs.writeFileSync()` but no directory recreation

**Issue**: If `.orchestrator/plans/` is deleted after initialization, subsequent saves will fail with ENOENT.

```typescript
// Current implementation
save(plan: PlanInstance): void {
  try {
    const serialized = this.serialize(plan);
    const filePath = this.getPlanFilePath(plan.id);
    fs.writeFileSync(filePath, JSON.stringify(serialized, null, 2)); // ENOENT if directory missing
    this.updateIndex(plan.id, plan.spec.name, plan.createdAt);
  } catch (error: any) {
    log.error(`Failed to save Plan: ${plan.id}`, { error: error.message });
    throw error; // Extension fails
  }
}
```

### 2. Plan Index Updates (`src/plan/persistence.ts`)

**Current Behavior:**
- `updateIndex()` method writes to `plans-index.json` 
- Also uses direct `fs.writeFileSync()` without directory verification

**Issue**: Index updates can fail if directory is missing.

### 3. Plan Logs (`src/plan/executor.ts`)

**Current Behavior:**
- Logs are stored via `setStoragePath()` in `.orchestrator/` directory
- Files created during job execution

**Issue**: Log writes will fail if `.orchestrator/` directory structure is missing.

### 4. Evidence Files (`src/plan/evidenceValidator.ts`)

**Current Behavior:**
- Evidence files stored in `.orchestrator/evidence/`
- No directory creation logic visible in validator

**Issue**: Evidence file creation will fail if evidence directory is missing.

### 5. Copilot CLI Session Data

**Current Behavior:**
- Session data stored in `.orchestrator/.copilot/` via `agentDelegator.ts`
- Uses `ensureDirAsync()` from `src/core/utils.ts` (line 309-311)

**Status**: ✅ **Properly handled** - Uses directory creation utilities.

## Delete Operation Issues

### Plan Deletion (`src/plan/runner.ts`)

**Current Behavior:**
```typescript
delete(planId: string): boolean {
  const plan = this.plans.get(planId);
  if (!plan) return false;
  
  // Cancel if running
  this.cancel(planId);
  
  // Clean up worktrees and branches in background
  this.cleanupPlanResources(plan).catch(err => {
    log.error(`Failed to cleanup Plan resources`, { planId, error: err.message });
  });
  
  // Remove from memory
  this.plans.delete(planId);
  this.stateMachines.delete(planId);
  
  // Remove from persistence  
  this.persistence.delete(planId); // Can fail silently
  
  // Notify listeners
  this.emit('planDeleted', planId);
  
  return true; // Always returns true even if file deletion failed
}
```

**Issue**: The method always returns `true` and emits `planDeleted` even if `persistence.delete()` fails. The UI updates to show the plan as deleted, but the files may still exist.

**Persistence Delete Behavior:**
```typescript
// From src/plan/persistence.ts
delete(planId: string): boolean {
  try {
    const filePath = this.getPlanFilePath(planId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      this.removeFromIndex(planId);
      return true;
    }
    return false; // File doesn't exist
  } catch (error: any) {
    log.error(`Failed to delete Plan: ${planId}`, { error: error.message });
    return false; // Deletion failed
  }
}
```

The issue is that `PlanRunner.delete()` doesn't check the return value from `persistence.delete()`.

## Available Utilities

The codebase has utilities for directory creation in `src/core/utils.ts`:

```typescript
// Synchronous
export function ensureDir(p: string) { 
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); 
}

// Asynchronous (preferred)
export async function ensureDirAsync(p: string): Promise<void> {
  try {
    await fs.promises.access(p);
  } catch {
    await fs.promises.mkdir(p, { recursive: true });
  }
}
```

## Recommended Fix Pattern

### 1. Central Orchestrator Directory Management

Create a utility function to ensure all orchestrator directories exist:

```typescript
function ensureOrchestratorDirs(workspacePath: string): void {
  const baseDir = path.join(workspacePath, '.orchestrator');
  ensureDir(baseDir);
  ensureDir(path.join(baseDir, 'plans'));
  ensureDir(path.join(baseDir, 'evidence'));
  ensureDir(path.join(baseDir, '.copilot'));
}
```

### 2. Apply Before All Filesystem Writes

**Plan Persistence (`src/plan/persistence.ts`):**
- Call `ensureOrchestratorDirs()` before `fs.writeFileSync()` in `save()` and `updateIndex()`

**Evidence Validator:**
- Ensure evidence directory exists before creating evidence files

**Executor Logs:**
- Verify log directory structure before writing

### 3. Fix Delete Operation Logic

**In `src/plan/runner.ts`:**
```typescript
delete(planId: string): boolean {
  const plan = this.plans.get(planId);
  if (!plan) return false;
  
  // Cancel if running
  this.cancel(planId);
  
  // Remove from memory FIRST (ensures UI consistency)
  this.plans.delete(planId);
  this.stateMachines.delete(planId);
  
  // Attempt filesystem cleanup (can fail silently)
  const fsDeleteSuccess = this.persistence.delete(planId);
  if (!fsDeleteSuccess) {
    log.warn(`Failed to delete plan files for ${planId}, but removed from memory`);
  }
  
  // Clean up worktrees in background
  this.cleanupPlanResources(plan).catch(err => {
    log.error(`Failed to cleanup Plan resources`, { planId, error: err.message });
  });
  
  // Notify listeners (plan is gone from memory regardless of FS result)
  this.emit('planDeleted', planId);
  
  return true;
}
```

## Implementation Strategy

1. **Add central directory management utility**
2. **Update `PlanPersistence.save()` to call `ensureOrchestratorDirs()` before writes**
3. **Update `PlanPersistence.updateIndex()` to ensure directory exists**
4. **Fix delete operation to prioritize in-memory state consistency**
5. **Add evidence directory creation in evidence validator**
6. **Ensure log directory creation in executor**

## Expected Outcome

After implementing these changes:
- ✅ Extension gracefully handles missing `.orchestrator/` directories
- ✅ Delete operations update UI correctly regardless of filesystem state  
- ✅ No more ENOENT errors during normal operation
- ✅ Extension remains functional after `git clean -dfx` or manual directory deletion

## Testing Strategy

1. **Create plans, then delete `.orchestrator/` directory externally**
2. **Verify saving new plans recreates directory structure**
3. **Delete plans when filesystem is missing, verify UI updates correctly**
4. **Run `git clean -dfx` during operation, verify graceful recovery**