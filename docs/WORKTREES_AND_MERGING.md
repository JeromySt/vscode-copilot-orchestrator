# Worktrees and Merging

This document explains how the Copilot Orchestrator uses git worktrees and merging to execute parallel jobs without disrupting the user's main working directory.

## Overview

The orchestrator runs multiple jobs in parallel, each in its own isolated git worktree. When jobs complete, their work is merged back to the target branch using fully in-memory `git merge-tree --write-tree` merges. This approach:

- **Isolates job execution** - Each job has its own working directory
- **Preserves user's workspace** - RI merges never touch any checkout; conflicts are resolved entirely in git objects
- **Creates clean history** - Squash merges produce single commits per job
- **Handles conflicts** - Copilot CLI resolves merge conflicts via temp dir extraction (no worktree needed)
- **Validates merges** - Optional `verify-ri` phase runs post-merge verification in a temporary worktree

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

### 2. Merge Operations (In-Memory)

Unlike job worktrees, **RI merges happen entirely in the git object store** using `git merge-tree --write-tree`. No worktree or checkout is needed for the merge itself:
- Merge tree is computed as a git tree object
- Conflicts are resolved by extracting files to a temp directory, running Copilot CLI, then hashing resolved files back
- Target branch ref is updated via `git branch -f`
- User's working tree is synced only if they have the target branch checked out

After the merge, an optional **verify-ri** phase creates a temporary worktree to validate the merged result.

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
| **`merge-ri`** | Reverse Integration — in-memory merge of leaf node's commit to snapshot/target branch |

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

#### FI Chain Continuity with `expectsNoChanges`

Validation nodes (e.g., typecheck, lint) often use `expectsNoChanges: true` to indicate they won't produce file changes. When such a node succeeds without creating a commit, it carries forward its `baseCommit` as its `completedCommit`:

```typescript
if (!result.completedCommit && !nodeState.completedCommit && nodeState.baseCommit) {
  nodeState.completedCommit = nodeState.baseCommit;
}
```

This ensures downstream nodes receive the correct parent commit during FI, rather than falling back to `plan.baseBranch`. Without this behavior, a linear chain like:

```
Code Change A → Typecheck (expectsNoChanges) → Code Change B
```

would break: Code Change B's FI would miss Code Change A's work because the Typecheck node would have no `completedCommit` to pass along, and the leaf RI merge would lose accumulated ancestor changes.

### Reverse Integration (RI)

When a leaf node completes and the plan has a `targetBranch`, the node's completed commit is merged to the target branch using a fully in-memory approach.

#### Aggregated Work for RI Merge

When a leaf node merges to targetBranch (RI phase), the work being merged includes all commits from the DAG path:

- Root node's changes (from baseBranch tip)
- All intermediate node changes (via FI merges)
- Leaf node's own changes

This is captured in `nodeState.aggregatedWorkSummary` and displayed in the Plan work summary view.

#### In-Memory Merge Process

The RI merge operates entirely on git objects — no checkout or worktree is needed:

```bash
# 1. Compute merge result as a tree object
git merge-tree --write-tree <target-branch> <completed-commit>
# Returns: tree SHA on stdout (even on conflicts, exit code 1 = conflicts)

# 2. If conflict-free (exit 0): create squash commit
git commit-tree <tree-sha> -p <target-sha> -m "message"
git branch -f <target> <new-commit>

# 3. If conflicts (exit 1): resolve in-memory (see below)
```

#### In-Memory Conflict Resolution

When `merge-tree` reports conflicts (exit code 1), the first line of stdout is still a valid tree SHA containing conflict markers. Resolution proceeds without any checkout:

```
1. Extract conflicted files from the merge tree to a temp directory:
   git cat-file -p <tree-sha>:<path> → .git/ri-conflict-<timestamp>/<path>

2. Run Copilot CLI to resolve conflicts in the temp directory

3. Hash resolved files back into git objects:
   git hash-object -w <resolved-file> → new blob SHA

4. Rebuild the tree with resolved blobs (using temp GIT_INDEX_FILE):
   git read-tree <original-tree>           # load base tree
   git update-index --cacheinfo <blob>,<path>  # replace conflicted blobs
   git write-tree                           # emit new tree

5. Create commit and update ref as in the fast path
```

#### Working Tree Sync

After updating the `targetBranch` ref, the orchestrator checks whether the user has that branch checked out and whether their working tree was clean **before** the ref move:

| User State (before ref update) | Sync Behavior |
|-------------------------------|---------------|
| On target branch, clean | `git reset --hard HEAD` (safe — nothing to lose) |
| On target branch, dirty | No-op — logs hint to `git reset --hard HEAD` after saving work |
| On different branch | No-op (ref was already updated) |

**Critical safety rule:** The orchestrator never uses `git stash` / `git stash pop` during RI merges. Dirtiness is checked **before** the ref move; after the ref update, the working tree always appears dirty relative to the new HEAD. Only a pre-move clean state allows automatic sync.

Working tree sync is **non-fatal** — if it fails, the merge commit and ref update have already succeeded.

### Snapshot-Based RI Merge (v0.12.0+)

Instead of merging each leaf directly into `targetBranch` during execution, leaf merges are accumulated in an isolated **snapshot branch + worktree**:

```
Plan Start
  └─ Create snapshot branch: orchestrator/snapshot/<planId> off targetBranch HEAD
  └─ Create real git worktree for snapshot branch
  └─ Pin snapshot.baseCommit — all root nodes use this SHA (not the branch ref)

Leaf Node Completes (work + commit)
  └─ merge-ri: merge leaf's commit into snapshot branch (in-memory merge-tree)

All Leaves Complete → Snapshot Validation Node Executes
  └─ assignedWorktreePath = snapshot worktree (no new worktree created)
  └─ prechecks: check targetBranch health (dirty/ahead detection, rebase if needed)
  └─ work: run verifyRiSpec (plan-level verification, e.g. build + test)
  └─ postchecks: re-check targetBranch before merge
  └─ merge-ri: merge snapshot → targetBranch
  └─ On failure with dirty targetBranch: force-fail (no auto-heal) with user message
  └─ On failure with advanced targetBranch: auto-retry from prechecks (rebase + re-verify)

Plan Complete
  └─ Clean up snapshot worktree + branch
```

**Key benefits:**
- **targetBranch untouched** during execution — no working tree desync
- **Root node consistency** — all root nodes start from `snapshot.baseCommit` (pinned SHA), not the live branch ref, so they all begin from the same codebase even if `targetBranch` advances
- **Single final merge** at the end — validated before applying
- **Snapshot validation is a regular JobNode** — identified by `producerId: '__snapshot-validation__'`, uses `assignedWorktreePath` to reuse the snapshot worktree, no separate execution path needed
- **Per-phase failure control** — `OnFailureConfig` on each phase controls auto-heal vs force-fail and retry reset points
- **Rebase handles forward movement** — if targetBranch advanced during execution, prechecks rebase the snapshot

#### Post-Merge Tree Validation

After every RI merge, file counts are compared between the result tree and both parent trees. If the result has <80% of the richer parent's file count, the merge is aborted as potentially destructive.

### Verify RI — Snapshot Validation Node (v0.12.0+)

Post-merge verification is now handled by the **Snapshot Validation** node — a regular `JobNode` auto-injected into every plan by the builder. This replaces the previous per-node `verify-ri` phase.

**How it works:**
1. The builder creates a `JobNode` with `producerId: '__snapshot-validation__'` that depends on all leaf nodes
2. When the snapshot is created, the pump sets `assignedWorktreePath` to the snapshot worktree path
3. The node's work phase runs the plan-level `verifyRiSpec` (e.g., `npm run build && npm test`)
4. Prechecks/postchecks handle targetBranch health: dirty detection → force-fail, ahead detection → rebase + retry
5. Merge RI goes directly to `targetBranch`
6. On success, the snapshot worktree is cleaned up when the plan completes

**Key properties:**
- **Regular JobNode** — No special execution path; uses the standard 7-phase executor pipeline
- **Plan-level, not per-node** — One `verifyRiSpec: WorkSpec` on `PlanSpec` applies to this node's work phase
- **Optional but highly recommended** — MCP schema marks `verify_ri` optional; examples always include it
- **Per-phase failure control** — `OnFailureConfig` on prechecks/postchecks controls force-fail (dirty target) vs auto-retry (target advanced)
- **Only one per plan** — Always the sole leaf node in the final plan DAG

## Merge Strategies

### In-Memory Merge via `git merge-tree` (Git 2.38+)

All RI merges use git's plumbing commands to merge **entirely in the object store**. Both conflict-free and conflict paths operate on git objects — no checkout or worktree is involved in the merge itself.

```bash
# Compute merge result as a tree object
git merge-tree --write-tree <target> <source>
# Exit 0 = clean merge, exit 1 = conflicts (tree still valid, contains markers)
# First line of stdout = tree SHA

# Create commit from tree (squash - single parent)
git commit-tree <tree-sha> -p <target-sha> -m "message"
# Returns: <new-commit-sha>

# Update branch ref
git branch -f <target> <new-commit>
```

**Updating the User's Working Tree (if applicable):**

| User State | Sync Behavior |
|------------|---------------|
| On target branch, clean | `git reset --hard <new-commit>` |
| On target branch, dirty | Stash → reset --hard → stash pop |
| On different branch | No-op (ref already updated) |

**Benefits:**
- No worktree creation overhead for the merge itself
- No disk I/O for working directory files (except optional sync)
- Never loses user's uncommitted work
- Conflict resolution isolated to temp directory
- **Safe** — the user's checkout is only touched after the merge commit succeeds

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

> **Note:** This mutex serializes only git worktree operations, not merge operations. RI merges use `git merge-tree` (which operates entirely on the object store) and never need worktree operations. Verify-RI creates a temporary worktree but acquires the mutex internally.

### Race Condition Prevention Strategy

The mutex prevents three classes of race conditions:

1. **Concurrent worktree creation** — Two jobs starting simultaneously both call `git worktree add`. Without serialization, both may try to write to `.git/worktrees/` at the same time, corrupting the worktree registry.

2. **Create/remove interleaving** — A job cleanup removing a worktree while another job is being created. The `remove` may delete shared git metadata that `add` is still writing.

3. **Concurrent worktree removal** — Multiple jobs completing at the same time all try to remove their worktrees. Git's worktree prune and remove operations can interfere with each other when run in parallel.

## Fetch on Resume and Retry

When a plan is paused (e.g., created with `startPaused=true`) the target branch may receive new commits before the plan is resumed. To prevent worktrees from being created against stale refs, the orchestrator fetches the latest remote state before resuming or retrying. Both `resume()` and `retryNode()` are async operations that return promises.

### Fetch on Resume

When `await resume(planId)` is called on a paused plan, the orchestrator runs `git fetch --all` before unpausing any nodes. This ensures all local refs reflect the current state of remote branches, so worktrees created for pending root nodes use the latest target branch commit.

### Fetch on Retry with clearWorktree

When `await retryNode(planId, nodeId, { clearWorktree: true })` is called, a `git fetch --all` is performed before the worktree is removed and recreated. This ensures the new worktree is based on the current base ref rather than a potentially outdated one.

### Graceful Failure Handling

Fetch failures are logged as warnings but **never block** the resume or retry operation. If the fetch fails (e.g., due to network issues), the plan proceeds with whatever refs are locally available.

### Scenarios

| Scenario | Behavior |
|----------|----------|
| **Fresh paused plan** (no nodes started) | Fetch updates all refs before any worktrees are created, so root nodes use the latest target branch commit |
| **Paused mid-execution** (some nodes pending) | Fetch ensures pending root nodes that haven't started yet get up-to-date refs |
| **Node retry after target branch advanced** | Fetch before worktree reset ensures the retried node works against the current base, not a stale snapshot |

## Conflict Resolution

When `git merge-tree` reports conflicts (exit code 1), the orchestrator resolves them without any checkout:

1. **Extract** conflicted files from the merge tree to `.git/ri-conflict-<timestamp>/`
2. **Resolve** — Copilot CLI runs in the temp directory with the task: "Resolve merge conflicts, preferring theirs"
3. **Hash** resolved files back into git blob objects via `git hash-object -w`
4. **Rebuild** the tree: load the base tree into a temp index, replace conflicted blobs, write new tree
5. **Commit** the resolved tree and update the target branch ref

```bash
# Extract conflicted file from merge tree
git cat-file -p <tree-sha>:<conflicted-path> > /tmp/ri-conflict/<path>

# After Copilot CLI resolves...
git hash-object -w /tmp/ri-conflict/<path>  # → new blob SHA

# Rebuild tree with temp index
GIT_INDEX_FILE=/tmp/ri-index git read-tree <original-tree>
GIT_INDEX_FILE=/tmp/ri-index git update-index --cacheinfo 100644,<blob-sha>,<path>
GIT_INDEX_FILE=/tmp/ri-index git write-tree  # → resolved tree SHA
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
3. **Conflict-free merges**: RI uses `git merge-tree` fast path (no disk I/O at all)
4. **Conflict merges**: Resolved in-memory — only conflicted files touch disk (temp dir), not the full working tree
4. **Parallel jobs**: Each job has isolated worktree; only worktree add/remove is serialized per-repo
5. **Mutex overhead**: The per-repo mutex adds minimal latency — only `git worktree add/remove` commands are serialized, not the actual job work
6. **Eager cleanup**: Non-leaf worktrees are removed as soon as all dependents consume them, reducing peak disk usage
