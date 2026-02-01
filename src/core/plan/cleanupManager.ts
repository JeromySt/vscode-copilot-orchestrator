/**
 * @fileoverview Plan Cleanup Manager - Handles worktree and branch cleanup.
 * 
 * Single responsibility: Clean up worktrees and branches for completed work units.
 * 
 * Uses the git/* modules for all git operations - fully async to avoid blocking.
 * 
 * @module core/plan/cleanupManager
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { Logger, ComponentLogger } from '../logger';
import { PlanSpec, InternalPlanState } from './types';
import * as git from '../../git';

const log: ComponentLogger = Logger.for('plans');

/**
 * Check if remote operations are enabled (pushOnSuccess setting).
 */
function isPushEnabled(): boolean {
  const cfg = vscode.workspace.getConfiguration('copilotOrchestrator.merge');
  return cfg.get<boolean>('pushOnSuccess', false);
}

/**
 * Clean up worktree and branch for a successfully merged work unit.
 * Also recursively cleans up any upstream producers that have all their
 * consumers now cleaned up.
 * 
 * Uses plan.cleanedWorkUnits to track what has been cleaned across calls.
 */
export async function cleanupWorkUnit(
  spec: PlanSpec,
  plan: InternalPlanState,
  workUnitId: string,
  repoPath: string
): Promise<void> {
  // Initialize cleanedWorkUnits if needed (for backward compat with persisted plans)
  if (!plan.cleanedWorkUnits) {
    plan.cleanedWorkUnits = new Set();
  }
  
  // Avoid re-cleaning already cleaned work units
  if (plan.cleanedWorkUnits.has(workUnitId)) return;

  // Clean up the worktree
  const worktreePath = plan.worktreePaths.get(workUnitId);
  if (worktreePath) {
    try {
      await fs.promises.access(worktreePath);
      const removed = await git.worktrees.removeSafe(repoPath, worktreePath, { 
        force: true,
        log: s => log.debug(s)
      });
      if (removed) {
        plan.worktreePaths.delete(workUnitId);
        log.debug(`Cleaned up worktree for ${workUnitId}`, { path: worktreePath });
      } else {
        log.warn(`Failed to remove worktree for ${workUnitId}`, { path: worktreePath });
        // Try force delete the directory anyway
        try {
          await fs.promises.rm(worktreePath, { recursive: true, force: true });
          plan.worktreePaths.delete(workUnitId);
        } catch {}
      }
    } catch {
      // Worktree doesn't exist, just clear the reference
      plan.worktreePaths.delete(workUnitId);
    }
  }

  // Clean up the branch (only the job-specific branch, not merge branches)
  const completedBranch = plan.completedBranches.get(workUnitId);
  if (completedBranch) {
    // Delete local branch
    const localDeleted = await git.branches.deleteLocal(repoPath, completedBranch, { 
      force: true,
      log: s => log.debug(s)
    });
    if (localDeleted) {
      log.debug(`Deleted local branch for ${workUnitId}`, { branch: completedBranch });
    } else {
      log.warn(`Failed to delete local branch for ${workUnitId}`, { branch: completedBranch });
    }

    // Only delete remote branch if pushOnSuccess is enabled (branches were pushed)
    if (isPushEnabled()) {
      const remoteDeleted = await git.branches.deleteRemote(repoPath, completedBranch, {
        log: s => log.debug(s)
      });
      if (remoteDeleted) {
        log.debug(`Deleted remote branch for ${workUnitId}`, { branch: completedBranch });
      }
    }

    plan.completedBranches.delete(workUnitId);
  }

  // Mark this work unit as cleaned
  plan.cleanedWorkUnits.add(workUnitId);

  log.info(`Cleaned up work unit ${workUnitId}`, {
    worktree: !!worktreePath,
    branch: !!completedBranch,
  });

  // Now check if any upstream producers can be cleaned up
  // A producer can be cleaned up if ALL its consumers have been cleaned up
  const job = spec.jobs.find(j => j.id === workUnitId);
  if (job) {
    for (const producerId of job.consumesFrom) {
      if (canCleanupProducer(spec, plan, producerId)) {
        await cleanupWorkUnit(spec, plan, producerId, repoPath);
      }
    }
  }

  // Also check sub-plan producers
  const subPlan = spec.subPlans?.find(sp => sp.id === workUnitId);
  if (subPlan) {
    for (const producerId of subPlan.consumesFrom) {
      if (canCleanupProducer(spec, plan, producerId)) {
        await cleanupWorkUnit(spec, plan, producerId, repoPath);
      }
    }
  }
}

/**
 * Check if a producer can be cleaned up.
 * A producer can only be cleaned up if ALL consumers that depend on it
 * have been cleaned up (tracked in plan.cleanedWorkUnits).
 */
export function canCleanupProducer(
  spec: PlanSpec,
  plan: InternalPlanState,
  producerId: string
): boolean {
  // Initialize cleanedWorkUnits if needed (backward compat)
  if (!plan.cleanedWorkUnits) {
    plan.cleanedWorkUnits = new Set();
  }
  
  // Don't cleanup if already cleaned
  if (plan.cleanedWorkUnits.has(producerId)) return false;
  
  // Don't cleanup if not finished yet
  if (!plan.done.includes(producerId) && !plan.completedSubPlans.has(producerId)) {
    return false;
  }

  // Find all consumers of this producer
  const consumers: string[] = [];
  for (const job of spec.jobs) {
    if (job.consumesFrom.includes(producerId)) {
      consumers.push(job.id);
    }
  }
  for (const sp of spec.subPlans || []) {
    if (sp.consumesFrom.includes(producerId)) {
      consumers.push(sp.id);
    }
  }

  // Producer can be cleaned up if ALL consumers have been cleaned up
  return consumers.every(consumerId => plan.cleanedWorkUnits.has(consumerId));
}

/**
 * Clean up all worktrees and branches for a plan.
 * Used when deleting a plan or cleaning up after failure.
 */
export async function cleanupAllPlanResources(
  spec: PlanSpec,
  plan: InternalPlanState,
  repoPath: string
): Promise<void> {
  log.info(`Cleaning up all resources for plan ${spec.id}`);

  // First, ensure we're on a safe branch (not one we're about to delete)
  // Switch to baseBranch or main/master
  const safeBranch = spec.baseBranch || 'main';
  try {
    const currentBranch = await git.branches.current(repoPath);
    // Check if current branch is one we might delete
    const branchesToDelete = new Set<string>();
    for (const [, branch] of plan.completedBranches) branchesToDelete.add(branch);
    for (const [, branch] of plan.subPlanIntegrationBranches || []) branchesToDelete.add(branch);
    if (plan.targetBranchRootCreated && plan.targetBranchRoot) branchesToDelete.add(plan.targetBranchRoot);
    
    if (branchesToDelete.has(currentBranch)) {
      log.debug(`Switching from ${currentBranch} to ${safeBranch} before cleanup`);
      await git.branches.checkout(repoPath, safeBranch);
    }
  } catch (err) {
    // Ignore - we'll proceed with cleanup and handle individual failures
    log.debug(`Could not check/switch branch before cleanup: ${err}`);
  }

  // Clean up all worktrees
  for (const [workUnitId, worktreePath] of plan.worktreePaths) {
    try {
      await fs.promises.access(worktreePath);
      const removed = await git.worktrees.removeSafe(repoPath, worktreePath, { 
        force: true,
        log: s => log.debug(s)
      });
      if (removed) {
        log.debug(`Removed worktree: ${worktreePath}`);
      } else {
        log.warn(`Failed to remove worktree ${worktreePath}`);
        try {
          await fs.promises.rm(worktreePath, { recursive: true, force: true });
        } catch {}
      }
    } catch {
      // Doesn't exist, skip
    }
  }
  plan.worktreePaths.clear();

  const pushEnabled = isPushEnabled();

  // Clean up all branches (local, and remote only if pushOnSuccess is enabled)
  for (const [workUnitId, branch] of plan.completedBranches) {
    const localDeleted = await git.branches.deleteLocal(repoPath, branch, { 
      force: true,
      log: s => log.debug(s)
    });
    if (!localDeleted) {
      log.warn(`Failed to delete local branch: ${branch}`);
    }
    if (pushEnabled) {
      await git.branches.deleteRemote(repoPath, branch, {
        log: s => log.debug(s)
      });
    }
  }
  plan.completedBranches.clear();

  // Clean up integration branches
  if (plan.subPlanIntegrationBranches) {
    for (const [subPlanId, branch] of plan.subPlanIntegrationBranches) {
      const localDeleted = await git.branches.deleteLocal(repoPath, branch, { 
        force: true,
        log: s => log.debug(s)
      });
      if (!localDeleted) {
        log.warn(`Failed to delete integration branch: ${branch}`);
      }
      if (pushEnabled) {
        await git.branches.deleteRemote(repoPath, branch, {
          log: s => log.debug(s)
        });
      }
    }
    plan.subPlanIntegrationBranches.clear();
  }

  // Clean up targetBranchRoot if we created it
  if (plan.targetBranchRootCreated && plan.targetBranchRoot) {
    const localDeleted = await git.branches.deleteLocal(repoPath, plan.targetBranchRoot, { 
      force: true,
      log: s => log.debug(s)
    });
    if (localDeleted) {
      log.debug(`Deleted targetBranchRoot: ${plan.targetBranchRoot}`);
    } else {
      log.warn(`Failed to delete targetBranchRoot: ${plan.targetBranchRoot}`);
    }
    if (pushEnabled) {
      await git.branches.deleteRemote(repoPath, plan.targetBranchRoot, {
        log: s => log.debug(s)
      });
    }
  }

  log.info(`Plan ${spec.id} resources cleaned up`);
}

/**
 * Clean up the worktree root directory for a plan.
 */
export async function cleanupWorktreeRoot(worktreeRoot: string): Promise<void> {
  try {
    await fs.promises.access(worktreeRoot);
    await fs.promises.rm(worktreeRoot, { recursive: true, force: true });
    log.debug(`Removed worktree root: ${worktreeRoot}`);
  } catch (e: any) {
    log.warn(`Failed to remove worktree root ${worktreeRoot}`, {
      error: e.message,
    });
  }
}
