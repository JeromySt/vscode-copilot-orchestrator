/**
 * @fileoverview Plan Merge Manager - Handles merging completed work back to target branches.
 * 
 * Single responsibility: Merge completed job/sub-plan branches to target branches,
 * including incremental (leaf) merging and final RI merge.
 * 
 * IMPORTANT: All merge operations use temporary worktrees to avoid touching the
 * user's main working directory. This prevents disruption to the user's work.
 * 
 * IMPORTANT: Merges to the same target branch are serialized using a per-branch
 * lock to prevent conflicts when multiple plans/jobs complete simultaneously.
 * 
 * @module core/plan/mergeManager
 */

import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import { Logger, ComponentLogger } from '../logger';
import { PlanSpec, InternalPlanState } from './types';
import * as git from '../../git';

const log: ComponentLogger = Logger.for('plans');

// ============================================================================
// MERGE LOCK - Serialize merges to the same target branch
// ============================================================================

/**
 * Per-branch merge locks to prevent concurrent merges to the same branch.
 * Key: "repoPath:targetBranch", Value: Promise that resolves when lock is released
 */
const mergeLocks = new Map<string, Promise<void>>();

/**
 * Acquire a lock for merging to a specific target branch.
 * Returns a release function that MUST be called when done.
 */
async function acquireMergeLock(repoPath: string, targetBranch: string): Promise<() => void> {
  const lockKey = `${repoPath}:${targetBranch}`;
  
  // Wait for any existing lock to release
  while (mergeLocks.has(lockKey)) {
    log.debug(`Waiting for merge lock on ${targetBranch}...`);
    await mergeLocks.get(lockKey);
  }
  
  // Create a new lock with a resolver
  let releaseLock: () => void = () => {};
  const lockPromise = new Promise<void>(resolve => {
    releaseLock = () => {
      mergeLocks.delete(lockKey);
      log.debug(`Released merge lock on ${targetBranch}`);
      resolve();
    };
  });
  
  mergeLocks.set(lockKey, lockPromise);
  log.debug(`Acquired merge lock on ${targetBranch}`);
  
  return releaseLock;
}

/**
 * Configuration for merge operations.
 */
interface MergeConfig {
  /** Which side to prefer on conflicts: 'ours' or 'theirs' */
  prefer: 'ours' | 'theirs';
  /** Whether to push to remote after successful merge */
  pushOnSuccess: boolean;
}

/**
 * Get merge configuration from VS Code settings.
 */
function getMergeConfig(): MergeConfig {
  const cfg = vscode.workspace.getConfiguration('copilotOrchestrator.merge');
  return {
    prefer: cfg.get<'ours' | 'theirs'>('prefer', 'theirs'),
    pushOnSuccess: cfg.get<boolean>('pushOnSuccess', false),
  };
}

/**
 * Result of a safe merge operation.
 */
interface SafeMergeResult {
  success: boolean;
  newCommit?: string;
  error?: string;
  userStateRestored: boolean;
}

/**
 * Merge a source commit into targetBranch safely, preserving user's work.
 * 
 * ## Merge Strategies (in order of preference)
 * 
 * 1. **Fast path** (git merge-tree, Git 2.38+): 
 *    Computes merge entirely in object store. Only for conflict-free merges.
 *    If target branch is not checked out: updates branch ref directly.
 *    If target branch IS checked out: needs to handle user state.
 * 
 * 2. **Main repo merge** (with state preservation):
 *    For conflicts or when target is checked out:
 *    - Stash user's uncommitted changes (if any)
 *    - Checkout targetBranch (if not already)
 *    - Perform merge (Copilot CLI resolves conflicts)
 *    - Restore user to original branch
 *    - Pop stash
 * 
 * ## Safety Guarantees
 * - User's uncommitted work is NEVER lost (stashed and restored)
 * - User's original branch is restored after merge
 * - If anything fails, user state is still restored
 * 
 * @param repoPath - Path to the main repository
 * @param sourceCommit - Commit SHA to merge from
 * @param targetBranch - Branch to merge into
 * @param commitMessage - Commit message for the merge
 * @param config - Merge configuration
 * @returns Result indicating success and any errors
 */
async function mergeToTargetSafely(
  repoPath: string,
  sourceCommit: string,
  targetBranch: string,
  commitMessage: string,
  config: MergeConfig
): Promise<SafeMergeResult> {
  log.debug(`Safe merge: ${sourceCommit.slice(0, 8)} into ${targetBranch}`);
  
  // Capture user's current state FIRST
  const originalBranch = await git.branches.currentOrNull(repoPath);
  const isOnTargetBranch = originalBranch === targetBranch;
  const isDirty = await git.repository.hasUncommittedChanges(repoPath);
  
  log.debug(`User state: branch=${originalBranch || 'detached'}, dirty=${isDirty}, onTarget=${isOnTargetBranch}`);
  
  // =========================================================================
  // FAST PATH: Try git merge-tree (no checkout needed for conflict-free)
  // =========================================================================
  const mergeTreeResult = await git.merge.mergeWithoutCheckout({
    source: sourceCommit,
    target: targetBranch,
    repoPath,
    log: s => log.debug(s)
  });
  
  if (mergeTreeResult.success && mergeTreeResult.treeSha) {
    log.info(`Fast path: conflict-free merge via merge-tree`);
    
    try {
      const targetSha = await git.repository.resolveRef(targetBranch, repoPath);
      const newCommit = await git.merge.commitTree(
        mergeTreeResult.treeSha,
        [targetSha],
        commitMessage,
        repoPath,
        s => log.debug(s)
      );
      
      // We have the new commit. Now we need to update the target branch.
      // The challenge: `git branch -f` fails if the branch is checked out anywhere.
      // 
      // Strategy:
      // 1. If user is on target branch: stash → reset --hard → unstash
      // 2. If user is on different branch: try branch -f, if fails → main repo merge
      
      if (isOnTargetBranch) {
        // User is on target branch - use reset --hard (safe with stash)
        if (isDirty) {
          const stashMsg = `orchestrator-merge-${Date.now()}`;
          await git.repository.stashPush(repoPath, stashMsg, s => log.debug(s));
          try {
            await execAsyncOrThrow(['reset', '--hard', newCommit], repoPath);
            await git.repository.stashPop(repoPath, s => log.debug(s));
          } catch (err) {
            await git.repository.stashPop(repoPath, s => log.debug(s));
            throw err;
          }
        } else {
          await execAsyncOrThrow(['reset', '--hard', newCommit], repoPath);
        }
        log.info(`Fast path: updated ${targetBranch} and working directory to ${newCommit.slice(0, 8)}`);
        
        if (config.pushOnSuccess) {
          await git.repository.push(repoPath, { branch: targetBranch, log: s => log.debug(s) });
        }
        return { success: true, newCommit, userStateRestored: true };
      }
      
      // User is NOT on target branch. We have the commit ready.
      // But `git branch -f` will fail if target is "associated" with main repo.
      // 
      // The safest approach: checkout target → reset → checkout back
      // This handles all edge cases where the branch might be "used by worktree"
      log.info(`Fast path: user on ${originalBranch || 'detached'}, switching to ${targetBranch} to apply commit`);
      
      if (isDirty) {
        const stashMsg = `orchestrator-merge-${Date.now()}`;
        await git.repository.stashPush(repoPath, stashMsg, s => log.debug(s));
      }
      
      try {
        // Switch to target branch
        await git.branches.checkout(repoPath, targetBranch, s => log.debug(s));
        // Reset to the new commit
        await execAsyncOrThrow(['reset', '--hard', newCommit], repoPath);
        log.info(`Fast path: updated ${targetBranch} to ${newCommit.slice(0, 8)}`);
        
        // Push if configured
        if (config.pushOnSuccess) {
          await git.repository.push(repoPath, { branch: targetBranch, log: s => log.debug(s) });
        }
        
        // Switch back to original branch
        if (originalBranch) {
          await git.branches.checkout(repoPath, originalBranch, s => log.debug(s));
        } else {
          // User was in detached HEAD - stay on target branch (can't go back to detached)
          log.debug(`User was in detached HEAD, staying on ${targetBranch}`);
        }
        
        // Restore stash
        if (isDirty) {
          await git.repository.stashPop(repoPath, s => log.debug(s));
        }
        
        return { success: true, newCommit, userStateRestored: true };
      } catch (err: any) {
        // Try to restore user state on error
        try {
          if (originalBranch) {
            const currentBranch = await git.branches.currentOrNull(repoPath);
            if (currentBranch !== originalBranch) {
              await git.branches.checkout(repoPath, originalBranch, s => log.debug(s));
            }
          }
          if (isDirty) {
            await git.repository.stashPop(repoPath, s => log.debug(s));
          }
        } catch (restoreErr) {
          log.error(`Failed to restore user state after fast path error: ${restoreErr}`);
        }
        throw err;
      }
    } catch (err: any) {
      log.warn(`Fast path failed: ${err.message}, falling back to main repo merge`);
    }
  }
  
  // =========================================================================
  // MAIN REPO MERGE: For conflicts or when fast path failed
  // =========================================================================
  if (mergeTreeResult.hasConflicts) {
    log.info(`Merge has conflicts, using main repo merge with Copilot CLI resolution`);
  } else {
    log.info(`Using main repo merge: ${mergeTreeResult.error || 'fast path failed'}`);
  }
  
  return mergeInMainRepo(repoPath, sourceCommit, targetBranch, commitMessage, config, {
    originalBranch,
    isOnTargetBranch,
    isDirty
  });
}

/**
 * Perform merge in main repo with full state preservation.
 */
async function mergeInMainRepo(
  repoPath: string,
  sourceCommit: string,
  targetBranch: string,
  commitMessage: string,
  config: MergeConfig,
  userState: { originalBranch: string | null; isOnTargetBranch: boolean; isDirty: boolean }
): Promise<SafeMergeResult> {
  const { originalBranch, isOnTargetBranch, isDirty } = userState;
  let didStash = false;
  let didCheckout = false;
  
  try {
    // Step 1: Stash uncommitted changes if needed
    if (isDirty) {
      const stashMsg = `orchestrator-autostash-${Date.now()}`;
      didStash = await git.repository.stashPush(repoPath, stashMsg, s => log.debug(s));
      log.info(`Stashed user's uncommitted changes`);
    }
    
    // Step 2: Checkout targetBranch if needed
    if (!isOnTargetBranch) {
      await git.branches.checkout(repoPath, targetBranch, s => log.debug(s));
      didCheckout = true;
      log.info(`Checked out ${targetBranch} for merge`);
    }
    
    // Step 3: Perform the squash merge
    const mergeSuccess = await attemptMerge(
      repoPath,
      sourceCommit,
      targetBranch,
      commitMessage,
      config,
      true  // squash
    );
    
    if (!mergeSuccess) {
      throw new Error('Merge failed');
    }
    
    const newHead = await git.repository.getHead(repoPath);
    log.info(`Merge completed: ${targetBranch} now at ${newHead?.slice(0, 8)}`);
    
    // Push if configured
    if (config.pushOnSuccess) {
      await git.repository.push(repoPath, { branch: targetBranch, log: s => log.debug(s) });
    }
    
    // Step 4: Restore user to original branch (if they weren't on target)
    if (didCheckout && originalBranch) {
      await git.branches.checkout(repoPath, originalBranch, s => log.debug(s));
      log.info(`Restored user to ${originalBranch}`);
    }
    
    // Step 5: Restore user's uncommitted changes
    if (didStash) {
      await git.repository.stashPop(repoPath, s => log.debug(s));
      log.info(`Restored user's uncommitted changes`);
    }
    
    return { success: true, newCommit: newHead || undefined, userStateRestored: true };
    
  } catch (error: any) {
    log.error(`Merge failed: ${error.message}`);
    
    // CRITICAL: Restore user state even on error
    try {
      // Try to abort any in-progress merge
      await git.merge.abort(repoPath, s => log.debug(s)).catch(() => {});
      
      // Restore branch if we changed it
      if (didCheckout && originalBranch) {
        const currentBranch = await git.branches.currentOrNull(repoPath);
        if (currentBranch !== originalBranch) {
          await git.branches.checkout(repoPath, originalBranch, s => log.debug(s));
          log.info(`Restored user to ${originalBranch} after error`);
        }
      }
      
      // Restore stash if we stashed
      if (didStash) {
        await git.repository.stashPop(repoPath, s => log.debug(s));
        log.info(`Restored user's uncommitted changes after error`);
      }
      
      return { success: false, error: error.message, userStateRestored: true };
    } catch (restoreError: any) {
      log.error(`CRITICAL: Failed to restore user state: ${restoreError.message}`);
      return { 
        success: false, 
        error: `${error.message}; ALSO failed to restore user state: ${restoreError.message}`,
        userStateRestored: false 
      };
    }
  }
}

// Helper to import execAsyncOrThrow for reset command
import { execAsyncOrThrow } from '../../git/core/executor';

/**
 * Check if a work unit is a leaf (nothing consumes from it).
 */
export function isLeafWorkUnit(spec: PlanSpec, workUnitId: string): boolean {
  // Check if any job consumes from this work unit
  for (const job of spec.jobs) {
    if (job.consumesFrom.includes(workUnitId)) {
      return false;
    }
  }
  // Check if any sub-plan consumes from this work unit
  for (const sp of spec.subPlans || []) {
    if (sp.consumesFrom.includes(workUnitId)) {
      return false;
    }
  }
  return true;
}

/**
 * Merge a completed leaf job's commit to targetBranch immediately.
 * This provides incremental value to the user as work completes.
 * 
 * IMPORTANT: Uses a temporary worktree for merge to avoid touching main repo.
 * IMPORTANT: Acquires a per-branch lock to serialize concurrent merges.
 * 
 * @param spec - Plan specification
 * @param plan - Internal plan state
 * @param jobId - ID of the completed job
 * @param completedCommit - Commit SHA or branch name to merge from
 * @param repoPath - Path to the repository
 */
export async function mergeLeafToTarget(
  spec: PlanSpec,
  plan: InternalPlanState,
  jobId: string,
  completedCommit: string,
  repoPath: string
): Promise<boolean> {
  const targetBranch = spec.targetBranch || spec.baseBranch || 'main';
  const planJob = spec.jobs.find(j => j.id === jobId);
  const config = getMergeConfig();

  log.info(`Merging leaf ${jobId} to ${targetBranch}`, {
    planId: spec.id,
    completedCommit: completedCommit.length > 20 ? completedCommit.slice(0, 8) : completedCommit,
  });

  // Acquire lock to prevent concurrent merges to the same target branch
  const releaseLock = await acquireMergeLock(repoPath, targetBranch);
  
  try {
    // Safely merge to target, preserving user's working state
    const result = await mergeToTargetSafely(
      repoPath,
      completedCommit,  // Can be branch name or commit SHA
      targetBranch,
      `Merge ${planJob?.name || jobId} from plan ${spec.name || spec.id}`,
      config
    );

    if (!result.success) {
      log.error(`Failed to merge leaf ${jobId}`, { error: result.error });
      if (!result.userStateRestored) {
        log.error(`CRITICAL: User's workspace state may not have been fully restored`);
      }
      return false;
    }

    // Track that this leaf has been merged
    plan.mergedLeaves.add(jobId);
    plan.riMergeCompleted = true;

    log.info(`Leaf ${jobId} merged successfully`, {
      totalMerged: plan.mergedLeaves.size,
      pushed: config.pushOnSuccess,
      newCommit: result.newCommit?.slice(0, 8),
    });

    return true;
  } catch (error: any) {
    log.error(`Failed to merge leaf ${jobId}`, { error: error.message });
    return false;
  } finally {
    // Always release the lock
    releaseLock();
  }
}

/**
 * Perform the final RI merge for a completed plan.
 * With incremental leaf merging, this is primarily a fallback/cleanup.
 * 
 * IMPORTANT: Acquires a per-branch lock to serialize concurrent merges.
 */
export async function performFinalMerge(
  spec: PlanSpec,
  plan: InternalPlanState,
  repoPath: string
): Promise<void> {
  const targetBranch = spec.targetBranch || spec.baseBranch || 'main';
  const config = getMergeConfig();

  // Find leaf jobs (jobs that no other job or sub-plan consumes from)
  const allConsumedFrom = new Set<string>();
  for (const job of spec.jobs) {
    job.consumesFrom.forEach(source => allConsumedFrom.add(source));
  }
  for (const sp of spec.subPlans || []) {
    sp.consumesFrom.forEach(source => allConsumedFrom.add(source));
  }

  const allLeafIds = new Set(
    spec.jobs
      .filter(j => !allConsumedFrom.has(j.id) && plan.done.includes(j.id))
      .map(j => j.id)
  );

  // Check which leaves haven't been merged yet
  const unmergedLeaves = [...allLeafIds].filter(id => !plan.mergedLeaves.has(id));

  if (unmergedLeaves.length === 0) {
    log.info(`All ${allLeafIds.size} leaves already merged incrementally`, {
      planId: spec.id,
    });
    plan.riMergeCompleted = true;
    await cleanupIntegrationBranches(plan, repoPath);
    return;
  }

  // Fallback: merge any leaves that weren't merged incrementally
  // Use worktree-based merge to avoid touching main repo
  log.warn(`${unmergedLeaves.length} leaves need fallback merge`, {
    planId: spec.id,
    unmerged: unmergedLeaves,
    alreadyMerged: [...plan.mergedLeaves],
  });

  // Acquire lock to prevent concurrent merges to the same target branch
  const releaseLock = await acquireMergeLock(repoPath, targetBranch);
  
  try {
    // Merge each unmerged leaf job's commit safely, preserving user state
    for (const leafJobId of unmergedLeaves) {
      const leafJob = spec.jobs.find(j => j.id === leafJobId);
      const leafCommit = plan.completedCommits.get(leafJobId);
      if (!leafCommit || !leafJob) continue;

      log.info(`Fallback merging commit ${leafCommit.slice(0, 8)} into ${targetBranch}`);

      const result = await mergeToTargetSafely(
        repoPath,
        leafCommit,
        targetBranch,
        `Merge ${leafJob.name || leafJob.id} from plan ${spec.name || spec.id}`,
        config
      );

      if (result.success) {
        plan.mergedLeaves.add(leafJobId);
        log.info(`Merged ${leafCommit.slice(0, 8)} to ${targetBranch}`, { newCommit: result.newCommit?.slice(0, 8) });
      } else {
        if (!result.userStateRestored) {
          log.error(`CRITICAL: User's workspace state may not have been fully restored`);
        }
        plan.error = `RI merge failed: conflict merging commit ${leafCommit.slice(0, 8)} - ${result.error}`;
        return;
      }
    }

    log.info(`RI merge completed`, { planId: spec.id, targetBranch, pushed: config.pushOnSuccess });

    plan.riMergeCompleted = true;
  } catch (error: any) {
    log.error(`Final RI merge failed`, { planId: spec.id, error: error.message });
    plan.error = `RI merge failed: ${error.message}`;
    plan.riMergeCompleted = false;
  } finally {
    // Always release the lock
    releaseLock();
  }
}

/**
 * Attempt a git merge, using Copilot CLI to resolve conflicts if needed.
 * 
 * @param repoPath - Working directory for the merge
 * @param sourceBranch - Branch/commit to merge from
 * @param targetBranch - Branch being merged into (for logging)
 * @param commitMessage - Commit message
 * @param config - Merge configuration
 * @param squash - If true, use squash merge (default: true for cleaner history)
 */
async function attemptMerge(
  repoPath: string,
  sourceBranch: string,
  targetBranch: string,
  commitMessage: string,
  config: MergeConfig,
  squash: boolean = true
): Promise<boolean> {
  // Use git.merge module with squash option
  const result = await git.merge.merge({
    source: sourceBranch,
    target: targetBranch,
    cwd: repoPath,
    message: commitMessage,
    squash,
    log: (msg) => log.debug(msg),
  });

  if (result.success) {
    log.info(`${squash ? 'Squash merged' : 'Merged'} ${sourceBranch} into ${targetBranch}`);
    return true;
  }

  if (!result.hasConflicts) {
    // Non-conflict failure
    log.error(`Merge failed`, { error: result.error });
    return false;
  }

  // Merge conflict - use Copilot CLI to resolve
  log.info(`Merge conflict, using Copilot CLI to resolve...`, {
    sourceBranch,
    targetBranch,
    conflictFiles: result.conflictFiles,
  });

  const mergeInstruction =
    `@agent Resolve the current git merge conflict. ` +
    `We are ${squash ? 'squash ' : ''}merging '${sourceBranch}' into '${targetBranch}'. ` +
    `Prefer '${config.prefer}' changes when there are conflicts. ` +
    `Resolve all conflicts, stage the changes with 'git add', and commit with message 'orchestrator: ${commitMessage}'`;

  const copilotCmd = `copilot -p ${JSON.stringify(mergeInstruction)} --allow-all-paths --allow-all-tools`;
  
  // Run async to avoid blocking the event loop
  const copilotResult = await new Promise<{ status: number | null }>((resolve) => {
    const child = spawn(copilotCmd, [], {
      cwd: repoPath,
      shell: true,
      timeout: 300000, // 5 minute timeout
    });
    
    child.on('close', (code) => {
      resolve({ status: code });
    });
    
    child.on('error', (err) => {
      log.error('Copilot CLI spawn error', { error: err.message });
      resolve({ status: 1 });
    });
  });

  if (copilotResult.status !== 0) {
    log.error(`Copilot CLI failed to resolve merge conflict`, {
      exitCode: copilotResult.status,
      sourceBranch,
      targetBranch,
    });
    // Abort the merge
    await git.merge.abort(repoPath);
    return false;
  }

  log.info(`Merge conflict resolved by Copilot CLI`);
  return true;
}

/**
 * Check if remote operations are enabled (pushOnSuccess setting).
 */
function isPushEnabled(): boolean {
  const cfg = vscode.workspace.getConfiguration('copilotOrchestrator.merge');
  return cfg.get<boolean>('pushOnSuccess', false);
}

/**
 * Clean up integration branches created for sub-plans.
 * 
 * NOTE: With the move to detached HEAD worktrees and commit-based merging,
 * integration branches are no longer created. This function is kept for
 * backwards compatibility with any old plans that may still have them.
 * 
 * @deprecated Integration branches are no longer used
 */
export async function cleanupIntegrationBranches(
  plan: InternalPlanState,
  repoPath: string
): Promise<void> {
  // No-op: integration branches are no longer created with detached HEAD worktrees
  // Old plans with subPlanIntegrationBranches will have these cleaned up by
  // the regular branch cleanup process if needed
  return;
}
