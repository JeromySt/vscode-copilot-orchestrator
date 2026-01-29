/**
 * @fileoverview Plan Cleanup Manager - Handles worktree and branch cleanup.
 * 
 * Single responsibility: Clean up worktrees and branches for completed work units.
 * 
 * Uses the git/* modules for all git operations - no direct execSync usage.
 * 
 * @module core/plan/cleanupManager
 */

import * as fs from 'fs';
import { Logger, ComponentLogger } from '../logger';
import { PlanSpec, InternalPlanState } from './types';
import * as git from '../../git';

const log: ComponentLogger = Logger.for('plans');

/**
 * Clean up worktree and branch for a successfully merged work unit.
 * Also recursively cleans up any upstream producers that have all their
 * consumers now cleaned up.
 */
export function cleanupWorkUnit(
  spec: PlanSpec,
  plan: InternalPlanState,
  workUnitId: string,
  repoPath: string,
  cleanedUp: Set<string> = new Set()
): void {
  // Avoid infinite recursion
  if (cleanedUp.has(workUnitId)) return;
  cleanedUp.add(workUnitId);

  // Clean up the worktree
  const worktreePath = plan.worktreePaths.get(workUnitId);
  if (worktreePath && fs.existsSync(worktreePath)) {
    const removed = git.worktrees.removeSafe(repoPath, worktreePath, { force: true });
    if (removed) {
      plan.worktreePaths.delete(workUnitId);
      log.debug(`Cleaned up worktree for ${workUnitId}`, { path: worktreePath });
    } else {
      log.warn(`Failed to remove worktree for ${workUnitId}`, { path: worktreePath });
      // Try force delete the directory anyway
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
        plan.worktreePaths.delete(workUnitId);
      } catch {}
    }
  }

  // Clean up the branch (only the job-specific branch, not merge branches)
  const completedBranch = plan.completedBranches.get(workUnitId);
  if (completedBranch) {
    // Delete local branch
    const localDeleted = git.branches.deleteLocal(repoPath, completedBranch, { force: true });
    if (localDeleted) {
      log.debug(`Deleted local branch for ${workUnitId}`, { branch: completedBranch });
    }

    // Delete remote branch
    const remoteDeleted = git.branches.deleteRemote(repoPath, completedBranch);
    if (remoteDeleted) {
      log.debug(`Deleted remote branch for ${workUnitId}`, { branch: completedBranch });
    }

    plan.completedBranches.delete(workUnitId);
  }

  log.info(`Cleaned up work unit ${workUnitId}`, {
    worktree: !!worktreePath,
    branch: !!completedBranch,
  });

  // Now check if any upstream producers can be cleaned up
  // A producer can be cleaned up if ALL its consumers have been cleaned up
  const job = spec.jobs.find(j => j.id === workUnitId);
  if (job) {
    for (const producerId of job.consumesFrom) {
      if (canCleanupProducer(spec, plan, producerId, cleanedUp)) {
        cleanupWorkUnit(spec, plan, producerId, repoPath, cleanedUp);
      }
    }
  }

  // Also check sub-plan producers
  const subPlan = spec.subPlans?.find(sp => sp.id === workUnitId);
  if (subPlan) {
    for (const producerId of subPlan.consumesFrom) {
      if (canCleanupProducer(spec, plan, producerId, cleanedUp)) {
        cleanupWorkUnit(spec, plan, producerId, repoPath, cleanedUp);
      }
    }
  }
}

/**
 * Check if a producer can be cleaned up.
 * A producer can only be cleaned up if ALL consumers that depend on it
 * have been merged and cleaned up.
 */
export function canCleanupProducer(
  spec: PlanSpec,
  plan: InternalPlanState,
  producerId: string,
  cleanedUp: Set<string>
): boolean {
  // Don't cleanup if already cleaned or not merged
  if (cleanedUp.has(producerId)) return false;
  if (!plan.mergedLeaves.has(producerId) && !plan.done.includes(producerId)) {
    // Producer hasn't finished yet
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
  return consumers.every(
    consumerId =>
      cleanedUp.has(consumerId) ||
      // A consumer counts as "cleaned up" if it was merged (for leaves)
      plan.mergedLeaves.has(consumerId)
  );
}

/**
 * Clean up all worktrees and branches for a plan.
 * Used when deleting a plan or cleaning up after failure.
 */
export function cleanupAllPlanResources(
  spec: PlanSpec,
  plan: InternalPlanState,
  repoPath: string
): void {
  log.info(`Cleaning up all resources for plan ${spec.id}`);

  // Clean up all worktrees
  for (const [workUnitId, worktreePath] of plan.worktreePaths) {
    if (fs.existsSync(worktreePath)) {
      const removed = git.worktrees.removeSafe(repoPath, worktreePath, { force: true });
      if (removed) {
        log.debug(`Removed worktree: ${worktreePath}`);
      } else {
        log.warn(`Failed to remove worktree ${worktreePath}`);
        try {
          fs.rmSync(worktreePath, { recursive: true, force: true });
        } catch {}
      }
    }
  }
  plan.worktreePaths.clear();

  // Clean up all branches (local and remote)
  for (const [workUnitId, branch] of plan.completedBranches) {
    git.branches.deleteLocal(repoPath, branch, { force: true });
    git.branches.deleteRemote(repoPath, branch);
  }
  plan.completedBranches.clear();

  // Clean up integration branches
  if (plan.subPlanIntegrationBranches) {
    for (const [subPlanId, branch] of plan.subPlanIntegrationBranches) {
      git.branches.deleteLocal(repoPath, branch, { force: true });
      git.branches.deleteRemote(repoPath, branch);
    }
    plan.subPlanIntegrationBranches.clear();
  }

  // Clean up targetBranchRoot if we created it
  if (plan.targetBranchRootCreated && plan.targetBranchRoot) {
    const localDeleted = git.branches.deleteLocal(repoPath, plan.targetBranchRoot, { force: true });
    if (localDeleted) {
      log.debug(`Deleted targetBranchRoot: ${plan.targetBranchRoot}`);
    }
    git.branches.deleteRemote(repoPath, plan.targetBranchRoot);
  }

  log.info(`Plan ${spec.id} resources cleaned up`);
}

/**
 * Clean up the worktree root directory for a plan.
 */
export function cleanupWorktreeRoot(worktreeRoot: string): void {
  if (fs.existsSync(worktreeRoot)) {
    try {
      fs.rmSync(worktreeRoot, { recursive: true, force: true });
      log.debug(`Removed worktree root: ${worktreeRoot}`);
    } catch (e: any) {
      log.warn(`Failed to remove worktree root ${worktreeRoot}`, {
        error: e.message,
      });
    }
  }
}
