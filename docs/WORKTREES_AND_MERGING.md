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

## Merge Lock

To prevent race conditions when multiple jobs complete simultaneously:

```typescript
const mergeLocks = new Map<string, Promise<void>>();

async function acquireMergeLock(repoPath: string, targetBranch: string) {
  const lockKey = `${repoPath}:${targetBranch}`;
  
  // Wait for existing lock
  while (mergeLocks.has(lockKey)) {
    await mergeLocks.get(lockKey);
  }
  
  // Create new lock
  let release;
  mergeLocks.set(lockKey, new Promise(r => release = () => {
    mergeLocks.delete(lockKey);
    r();
  }));
  
  return release;
}
```

This ensures merges to the same target branch are serialized, preventing conflicts from concurrent merge attempts.

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

### Automatic Cleanup

Worktrees are cleaned up automatically when:
- Job completes (success or failure)
- Plan completes
- Merge worktree finishes (in `finally` block)

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
3. **Conflict-free merges**: Use fast path (no disk I/O for working dir)
4. **Parallel jobs**: Each job has isolated worktree, no lock contention
