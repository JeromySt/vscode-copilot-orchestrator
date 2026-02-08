# Worktrees and Merging

This document explains how the Copilot Orchestrator uses git worktrees and merging to execute parallel jobs without disrupting the user's main working directory.

## Overview

The orchestrator runs multiple jobs in parallel, each in its own isolated git worktree. When jobs complete, their work is merged back to the target branch using squash merges. This approach:

- **Isolates job execution** - Each job has its own working directory
- **Preserves user's workspace** - Main repo is never modified during job execution
- **Creates clean history** - Squash merges produce single commits per job
- **Handles conflicts** - Copilot CLI resolves merge conflicts automatically

## Worktree Types

### 1. Job Worktrees (Detached HEAD)

Job worktrees are created in **detached HEAD mode** - no branches are created.

```bash
git worktree add --detach <path> <commit>
```

**Why detached HEAD?**
- No branches to manage, track, or clean up
- No "branch already checked out" errors
- Commits are tracked by SHA, not branch name
- Simpler cleanup - just remove the worktree directory

**Location:** `<repoPath>/.worktrees/<jobId>/`

### 2. Merge Operations (Main Repo)

Unlike job worktrees, **merges happen in the main repository** with full state preservation.
This allows:
- Conflicts to appear in the user's editor (where Copilot can resolve them)
- User to see and review merge results
- Full git conflict resolution tooling

The merge system automatically handles the user's workspace state (stashing, branch switching, etc.)

## Commit Flow

### Single Parent Job (Linear Chain)

```
Target Branch (main)
    │
    └── Job A worktree created from main (detached at commit X)
            │
            └── Job A makes commits → Final commit SHA1
                    │
                    └── Job B worktree created from SHA1 (detached)
                            │
                            └── Job B makes commits → Final commit SHA2
                                    │
                                    └── Squash merge SHA2 → main
```

### Multiple Parent Job (Diamond Pattern)

```
                    ┌── Job B (from SHA1) → SHA2
Target Branch ──→ Job A → SHA1 ──┤
                    └── Job C (from SHA1) → SHA3
                                    │
                            Job D created from SHA2
                            Then merges SHA3 into worktree
                            Makes commits → SHA4
                                    │
                            Squash merge SHA4 → main
```

## Merge Phases

Each node in a plan progresses through well-defined phases. Merging occurs in two distinct phases:

```
merge-fi → prechecks → work → commit → postchecks → merge-ri
```

| Phase | Description |
|-------|-------------|
| **`merge-fi`** | Forward Integration — merge dependency commits into the node's worktree |
| **`prechecks`** | Pre-execution validation (e.g., build, lint) |
| **`work`** | Copilot agent executes the task |
| **`commit`** | Changes are committed in the worktree |
| **`postchecks`** | Post-execution validation (e.g., tests) |
| **`merge-ri`** | Reverse Integration — merge leaf node's commit to the target branch |

If any phase fails, the `failedPhase` field is set on the node state, enabling targeted retries that skip already-completed phases.

### Forward Integration (FI)

When a node has dependencies, their completed commits must be merged into the node's worktree before work begins.

**Process:**
1. The worktree is created at the first dependency's commit (detached HEAD)
2. Additional dependency commits are merged into the worktree one at a time
3. Each merge uses `git merge` with fast-forward allowed
4. Conflicts are resolved automatically via Copilot CLI
5. After successful FI, consumption is acknowledged to all dependencies

```
Dependency A (commit SHA1)  ─┐
                              ├──→  Node X worktree (created at SHA1, merges SHA2)
Dependency B (commit SHA2)  ─┘
```

**Consumption tracking:** After FI, the node acknowledges consumption of each dependency's output. This is tracked via `consumedByDependents` on each dependency's state, which drives worktree cleanup eligibility (see below).

### Reverse Integration (RI)

When a leaf node completes and the plan has a `targetBranch`, the node's completed commit is merged to the target branch.

**Fast path (`git merge-tree`):**
```bash
# Compute merge result as a tree object (no checkout needed)
git merge-tree --write-tree <target-branch> <completed-commit>

# Create squash commit from tree (single parent = target branch)
git commit-tree <tree-sha> -p <target-sha> -m "message"

# Update branch ref
git branch -f <target> <new-commit>
```

**Conflict path:** If `merge-tree` detects conflicts, falls back to main repo merge with Copilot CLI conflict resolution (see below).

## Merge Strategies

### 1. Fast Path: `git merge-tree` (Git 2.38+)

For conflict-free merges, we use git's plumbing commands to merge **entirely in the object store** without any worktree:

```bash
# Compute merge result as a tree object
git merge-tree --write-tree <target> <source>
# Returns: <tree-sha>

# Create commit from tree (squash - single parent)
git commit-tree <tree-sha> -p <target-sha> -m "message"
# Returns: <new-commit-sha>

# Update branch/working directory (see below)
```

**Updating the Target Branch:**

The approach depends on whether the user has the target branch checked out:

| User State | Fast Path Behavior |
|------------|-------------------|
| On target branch, clean | `git reset --hard <new-commit>` |
| On target branch, dirty | Stash → reset → unstash |
| On different branch | `git branch -f <target> <new-commit>` |

**Benefits:**
- No worktree creation overhead  
- No disk I/O for working directory files (except when target is checked out)
- Fastest possible merge path
- **Safe** - always preserves user's uncommitted work via stash

### 2. Main Repo Merge (Conflicts or Fast Path Failure)

When conflicts occur or `git merge-tree` can't be used, the merge happens in the **main repository** 
with full state preservation:

```
┌──────────────────────────────────────────────────────────────┐
│  SAFETY GUARANTEE: User's work is NEVER lost                 │
│  - Uncommitted changes are stashed before any operation      │
│  - Original branch is restored after merge                   │
│  - Stash is popped even if merge fails                       │
└──────────────────────────────────────────────────────────────┘
```

**State Preservation Flow:**

```
User State Before Merge          →    During Merge         →    After Merge
────────────────────────────────────────────────────────────────────────────
On target branch, clean          →    Merge directly       →    Stay on target
On target branch, dirty          →    Stash → Merge        →    Stash pop
On different branch, clean       →    Checkout → Merge     →    Checkout back
On different branch, dirty       →    Stash → Checkout     →    Checkout → Pop
                                      → Merge
```

**Full Process:**

```bash
# 1. Capture user's current state
ORIGINAL_BRANCH=$(git branch --show-current)
IS_DIRTY=$(git status --porcelain | head -1)

# 2. Stash uncommitted changes (if any)
if [ -n "$IS_DIRTY" ]; then
  git stash push -m "orchestrator-autostash-<timestamp>"
fi

# 3. Checkout target branch (if needed)
if [ "$ORIGINAL_BRANCH" != "<target>" ]; then
  git checkout <target>
fi

# 4. Perform squash merge
git merge --squash <source-commit>

# 5. If conflicts, Copilot CLI resolves them
if [ $? -ne 0 ]; then
  copilot -p "Resolve the merge conflict..." --allow-all-paths --allow-all-tools
fi

# 6. Commit the merge
git commit -m "message"

# 7. Restore user to original branch
if [ "$ORIGINAL_BRANCH" != "<target>" ]; then
  git checkout "$ORIGINAL_BRANCH"
fi

# 8. Restore user's uncommitted changes
if [ -n "$DID_STASH" ]; then
  git stash pop
fi
```

**Error Recovery:**

If the merge fails at any point, the system:
1. Aborts any in-progress merge (`git merge --abort`)
2. Restores the user to their original branch (if changed)
3. Pops the stash (if stashed)
4. Reports the error without losing any user work

## Squash vs Regular Merge

| Aspect | Squash Merge | Regular Merge |
|--------|--------------|---------------|
| **Used for** | Leaf → Target branch | Parent → Child worktree |
| **Parents** | Single parent (target) | Both parents preserved |
| **History** | Clean, linear | Full ancestry visible |
| **Why** | User's branch stays clean | Child jobs need full context |

### Why Squash for Leaf-to-Target?

When a leaf job completes and merges to the target branch:
- All intermediate job commits are squashed into one
- Target branch history shows one commit per job/feature
- User sees clean, meaningful commits

### Why Regular for Parent-to-Worktree?

When a job has multiple parents (consumes from multiple jobs):
- Child job's worktree gets full history from all parents
- Child can see all commits from ancestors
- Important for understanding context during execution

## Per-Repository Mutex Locking

Git's `worktree add` and `worktree remove` commands have a race condition when run in parallel on the same repository, causing `"failed to read .git/worktrees/<id>/commondir"` errors. To prevent this, all worktree operations are serialized per-repository using a mutex.

```typescript
const repoMutexes = new Map<string, Promise<void>>();

async function acquireRepoMutex(repoPath: string): Promise<() => void> {
  const normalizedPath = path.resolve(repoPath).toLowerCase();

  // Wait for any existing operation to complete
  while (repoMutexes.has(normalizedPath)) {
    await repoMutexes.get(normalizedPath);
  }

  // Create a new promise that will resolve when we release
  let release: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  repoMutexes.set(normalizedPath, promise);

  return () => {
    repoMutexes.delete(normalizedPath);
    release!();
  };
}
```

**Key design decisions:**

| Aspect | Choice | Rationale |
|--------|--------|-----------|
| **Lock scope** | Per-repository (normalized path) | Different repos can run in parallel safely |
| **Serialization** | All worktree add/remove ops | Git's internal `.git/worktrees/` directory is the shared resource |
| **Release** | Try/finally in every caller | Guarantees release even on error |
| **Path normalization** | `path.resolve().toLowerCase()` | Prevents duplicate locks from path variations |

Every worktree operation (`create`, `createDetached`, `remove`, `removeSafe`, `createOrReuseDetached`) acquires the repo mutex before executing any git commands:

```typescript
const releaseMutex = await acquireRepoMutex(repoPath);
try {
  await execAsyncOrThrow(['worktree', 'add', '--detach', worktreePath, fromRef], repoPath);
} finally {
  releaseMutex();
}
```

> **Note:** This mutex serializes only git worktree operations, not merge operations. Merges use `git merge-tree` (which operates on the object store) or `git merge --squash` (which operates in the main repo), neither of which conflicts with worktree add/remove.

### Race Condition Prevention Strategy

The mutex prevents three classes of race conditions:

1. **Concurrent worktree creation** — Two jobs starting simultaneously both call `git worktree add`. Without serialization, both may try to write to `.git/worktrees/` at the same time, corrupting the worktree registry.

2. **Create/remove interleaving** — A job cleanup removing a worktree while another job is being created. The `remove` may delete shared git metadata that `add` is still writing.

3. **Concurrent worktree removal** — Multiple jobs completing at the same time all try to remove their worktrees. Git's worktree prune and remove operations can interfere with each other when run in parallel.

## Conflict Resolution

When merge conflicts occur, Copilot CLI is invoked:

```bash
copilot -p "@agent Resolve the current git merge conflict. \
  We are squash merging '<source>' into '<target>'. \
  Prefer 'theirs' changes when there are conflicts. \
  Resolve all conflicts, stage with 'git add', and commit." \
  --allow-all-paths --allow-all-tools
```

The `prefer` setting (`ours` or `theirs`) is configurable in VS Code settings:
- `copilotOrchestrator.merge.prefer`: `'ours'` | `'theirs'` (default: `'theirs'`)

## Worktree Cleanup

### Automatic Cleanup (During Execution)

Worktrees are cleaned up eagerly during plan execution to minimize disk usage:

**Non-leaf nodes:** Cleaned up once all downstream dependents have completed Forward Integration (consumed the node's output). This is tracked via the `consumedByDependents` array on each node's state.

```
Node A completes → Node B does FI (consumes A) → Node C does FI (consumes A) → A's worktree cleaned up
```

**Leaf nodes:** Cleaned up after successful Reverse Integration merge to the target branch.

The `cleanUpSuccessfulWork` plan-level setting controls whether automatic cleanup occurs (default: `true`).

### Cleanup on Plan Cancellation

When a plan is canceled (`cancel()`) or deleted (`delete()`), worktree cleanup follows a specific sequence:

```
cancel(planId)
  ├── 1. Cancel all running/scheduled nodes in executor
  ├── 2. Transition all non-terminal nodes to 'canceled' (via sm.cancelAll())
  └── 3. Persist updated state

delete(planId)
  ├── 1. cancel(planId)  — stops all work
  ├── 2. cleanupPlanResources(plan)  — runs in BACKGROUND (non-blocking)
  │     ├── Collect all worktree paths from nodeStates
  │     ├── removeSafe() each worktree (acquires repo mutex internally)
  │     └── Remove log files from executor storage
  ├── 3. Remove from in-memory maps
  ├── 4. Remove from persistence
  └── 5. Emit 'planDeleted' event
```

**Key design decisions:**
- `cancel()` stops work but does **not** clean up worktrees — the plan remains inspectable
- `delete()` cancels first, then cleans up resources **in the background** to avoid blocking the UI
- Cleanup errors are logged but never thrown — partial cleanup is acceptable
- Each `removeSafe()` call acquires the per-repo mutex, so concurrent cleanups are serialized
- With detached HEAD worktrees, there are no branches to clean up

### Manual Cleanup

If worktrees are left behind (e.g., extension crash):

```bash
# List all worktrees
git worktree list

# Remove specific worktree
git worktree remove <path> --force

# Prune stale worktree entries
git worktree prune
```

## Configuration

### VS Code Settings

```json
{
  // Merge conflict resolution preference
  "copilotOrchestrator.merge.prefer": "theirs",
  
  // Push to remote after successful merge
  "copilotOrchestrator.merge.pushOnSuccess": false
}
```

### Plan-Level Settings

```typescript
{
  // Custom worktree root (default: .worktrees)
  worktreeRoot: '.worktrees',
  
  // Clean up worktrees on success (default: true)
  cleanUpSuccessfulWork: true,
}
```

## Troubleshooting

### "Branch already checked out"

This error should not occur with the detached HEAD approach. If it does:
1. Check if there's a stale worktree: `git worktree list`
2. Remove it: `git worktree remove <path> --force`
3. Prune: `git worktree prune`

### Merge Conflicts Not Resolving

1. Check Copilot CLI is installed: `copilot --version`
2. Check the merge.prefer setting is appropriate for your use case
3. Review the job log for conflict details

### Worktrees Not Cleaning Up

1. Check if extension crashed during execution
2. Manually clean up: `git worktree list` → `git worktree remove`
3. Check `.worktrees/` directory for leftover folders

## Performance Considerations

1. **Submodules**: Worktrees use symlinks to main repo's submodules (fast)
2. **Large repos**: Worktree creation shares objects with main repo (no clone)
3. **Conflict-free merges**: RI uses `git merge-tree` fast path (no disk I/O for working dir)
4. **Parallel jobs**: Each job has isolated worktree; only worktree add/remove is serialized per-repo
5. **Mutex overhead**: The per-repo mutex adds minimal latency — only `git worktree add/remove` commands are serialized, not the actual job work
6. **Eager cleanup**: Non-leaf worktrees are removed as soon as all dependents consume them, reducing peak disk usage
