---
applyTo: '.worktrees/fbc77e7d/**'
---

# Current Task

# Internalize git.executor — Interface-Driven Approach

## Architecture
- `IGitExecutor` interface stays PUBLIC in `src/interfaces/IGitOperations.ts` — tests mock this
- `executor` REMOVED from `IGitOperations` composite interface — consumers use typed functions
- `executor` REMOVED from `git/core/index.ts` exports — no raw git commands outside git module
- Internal git modules (branches, merge, repository, worktrees) use executor internally
- New functions added to `IGitRepository` for operations that were using raw executor externally

## Step 1: Update `src/interfaces/IGitOperations.ts`

### Remove `executor` from `IGitOperations`:
```typescript
export interface IGitOperations {
  readonly branches: IGitBranches;
  readonly worktrees: IGitWorktrees;
  readonly merge: IGitMerge;
  readonly repository: IGitRepository;
  // executor REMOVED — use typed repository/branches/merge functions instead
  // IGitExecutor is still public for DI/construction of git modules
}
```

### Add missing functions to `IGitRepository`:
```typescript
export interface IGitRepository {
  // ... existing functions ...
  
  // NEW: File staging
  stageFile(cwd: string, filePath: string, log?: GitLogger): Promise<void>;
  
  // NEW: File diffs
  getFileDiff(repoPath: string, filePath: string): Promise<string | null>;
  getStagedFileDiff(repoPath: string, filePath: string): Promise<string | null>;
  
  // NEW: Stash inspection
  stashShowFiles(repoPath: string): Promise<string[]>;
  stashShowPatch(repoPath: string): Promise<string | null>;
  stashDrop(repoPath: string, index?: number, log?: GitLogger): Promise<void>;
  
  // NEW: Diff between refs
  hasChangesBetween(from: string, to: string, repoPath: string): Promise<boolean>;
  
  // NEW: Additional functions already used via executor
  getDirtyFiles(repoPath: string): Promise<string[]>;
  checkoutFile(repoPath: string, filePath: string, log?: GitLogger): Promise<void>;
  resetHard(repoPath: string, ref: string, log?: GitLogger): Promise<void>;
  updateRef(repoPath: string, ref: string, newValue: string, log?: GitLogger): Promise<void>;
}
```

Note: Some of these may already be on the interface — check and only add what's missing.

## Step 2: Implement new functions in `src/git/core/repository.ts`

Add the implementations using the INTERNAL executor:
```typescript
import { execAsync, execAsyncOrNull, execAsyncOrThrow } from './executor';

export async function stageFile(cwd: string, filePath: string, log?: GitLogger): Promise<void> {
  await execAsync(['add', filePath], { cwd, log });
}

export async function getFileDiff(repoPath: string, filePath: string): Promise<string | null> {
  return execAsyncOrNull(['diff', filePath], repoPath);
}

export async function getStagedFileDiff(repoPath: string, filePath: string): Promise<string | null> {
  return execAsyncOrNull(['diff', '--cached', filePath], repoPath);
}

export async function stashShowFiles(repoPath: string): Promise<string[]> {
  const result = await execAsyncOrNull(['stash', 'show', '--name-only'], repoPath);
  return result ? result.split(/\r?\n/).filter(Boolean) : [];
}

export async function stashShowPatch(repoPath: string): Promise<string | null> {
  return execAsyncOrNull(['stash', 'show', '-p'], repoPath);
}

export async function hasChangesBetween(from: string, to: string, repoPath: string): Promise<boolean> {
  const stats = await getDiffStats(from, to, repoPath);
  return (stats.added + stats.modified + stats.deleted) > 0;
}
```

Check which functions already exist (getDirtyFiles, checkoutFile, resetHard, updateRef, stashDrop were added earlier) and only add what's missing.

## Step 3: Migrate `src/plan/executionEngine.ts`

Replace ALL `git.executor.*` calls:
- `git.executor.execAsync(['add', '.gitignore'], { cwd })` → `git.repository.stageFile(cwd, '.gitignore')`
- `git.executor.execAsyncOrNull(['diff', '.gitignore'], repoPath)` → `git.repository.getFileDiff(repoPath, '.gitignore')`
- `git.executor.execAsyncOrNull(['diff', '--cached', '.gitignore'], repoPath)` → `git.repository.getStagedFileDiff(repoPath, '.gitignore')`
- `git.executor.execAsyncOrNull(['stash', 'show', '--name-only'], repoPath)` → `git.repository.stashShowFiles(repoPath)`
- `git.executor.execAsyncOrNull(['stash', 'show', '-p'], repoPath)` → `git.repository.stashShowPatch(repoPath)`

Also check the RI merge diff (may already use getDiffStats/hasChangesBetween).

## Step 4: Remove executor from `src/git/core/index.ts`

Change:
```typescript
export * as executor from './executor';
```
To: remove the line entirely. Keep type exports:
```typescript
export type { GitLogger, CommandResult, ExecuteOptions } from './executor';
```

## Step 5: Update `src/git/index.ts` if it re-exports executor

## Step 6: Update ALL test files

Test files that stub `git.executor.*` need to stub the new `git.repository.*` functions instead. Search for `git.executor` in `src/test/` and update each:
- `sandbox.stub(git.executor, 'execAsync')` → `sandbox.stub(git.repository, 'stageFile')` (or whichever function matches)
- `sandbox.stub(git.executor, 'execAsyncOrNull')` → `sandbox.stub(git.repository, 'getFileDiff')` etc.

Tests that need low-level executor access for coverage testing should mock `IGitExecutor` directly.

## Step 7: Verify
- `npx tsc --noEmit`
- No code outside `src/git/` references executor directly

## Read These Files First
- `src/interfaces/IGitOperations.ts` (FULL — has IGitExecutor, IGitRepository, IGitOperations)
- `src/git/core/index.ts` (exports)
- `src/git/index.ts` (re-exports)
- `src/git/core/repository.ts` (existing functions — check what already exists)
- `src/plan/executionEngine.ts` (search for `git.executor`)
- `src/agent/agentDelegator.ts` (search for `git.executor`)

## Constraints
- `IGitExecutor` interface stays PUBLIC (for DI/testing)
- `executor` concrete module becomes internal to `src/git/`
- No behavior change
- Update IGitRepository interface with ALL new functions
- Tests mock IGitExecutor or the higher-level interfaces, never import executor directly



## Guidelines

- Focus only on the task described above
- Make minimal, targeted changes
- Follow existing code patterns and conventions in this repository
- Commit your changes when complete
