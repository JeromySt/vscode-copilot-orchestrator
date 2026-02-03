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
import * as path from 'path';
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
  log.info(`Starting cleanup for work unit ${workUnitId}`, {
    planId: spec.id,
    hasWorktreePath: plan.worktreePaths.has(workUnitId),
    hasCompletedCommit: plan.completedCommits.has(workUnitId),
  });
  
  // Initialize cleanedWorkUnits if needed (for backward compat with persisted plans)
  if (!plan.cleanedWorkUnits) {
    plan.cleanedWorkUnits = new Set();
  }
  
  // Avoid re-cleaning already cleaned work units
  if (plan.cleanedWorkUnits.has(workUnitId)) {
    log.debug(`Skipping cleanup for ${workUnitId} - already cleaned`);
    return;
  }

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

  // NOTE: With detached HEAD worktrees, there are no branches to clean up.
  // Commits are tracked by SHA in completedCommits, which don't need cleanup.
  // Clear the commit reference since the worktree is gone.
  plan.completedCommits.delete(workUnitId);
  plan.baseCommits.delete(workUnitId);

  // Mark this work unit as cleaned
  plan.cleanedWorkUnits.add(workUnitId);

  log.info(`Cleaned up work unit ${workUnitId}`, {
    worktree: !!worktreePath,
  });

  // Now check if any upstream producers can be cleaned up
  // A producer can be cleaned up if ALL its consumers have been cleaned up
  const job = spec.jobs.find(j => j.id === workUnitId);
  if (job && job.consumesFrom.length > 0) {
    log.debug(`Checking if producers of ${workUnitId} can be cleaned up`, { producers: job.consumesFrom });
    for (const producerId of job.consumesFrom) {
      const canCleanup = canCleanupProducer(spec, plan, producerId);
      log.debug(`Producer ${producerId} cleanup check: ${canCleanup}`);
      if (canCleanup) {
        log.info(`Triggering cleanup for producer ${producerId} (all consumers cleaned)`);
        await cleanupWorkUnit(spec, plan, producerId, repoPath);
      }
    }
  }

  // Also check sub-plan producers
  const subPlan = spec.subPlans?.find(sp => sp.id === workUnitId);
  if (subPlan && subPlan.consumesFrom.length > 0) {
    for (const producerId of subPlan.consumesFrom) {
      if (canCleanupProducer(spec, plan, producerId)) {
        log.info(`Triggering cleanup for producer ${producerId} (all consumers cleaned)`);
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
 * 
 * NOTE: This may change the main repo's checked-out branch if it's currently
 * on a branch that will be deleted. This is acceptable because cleanup is
 * only triggered by explicit user action (delete plan), not during normal operation.
 * 
 * NOTE: With detached HEAD worktrees, there are no branches to clean up.
 * We only need to remove worktrees and clear commit tracking.
 */
export async function cleanupAllPlanResources(
  spec: PlanSpec,
  plan: InternalPlanState,
  repoPath: string
): Promise<void> {
  log.info(`Cleaning up all resources for plan ${spec.id}`, {
    worktreeCount: plan.worktreePaths.size,
    commitCount: plan.completedCommits.size,
    worktrees: Array.from(plan.worktreePaths.entries()),
  });

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

  // Clear commit tracking (no branches to delete with detached HEAD worktrees)
  plan.completedCommits.clear();
  plan.baseCommits.clear();
  plan.completedSubPlans.clear();

  log.info(`Plan ${spec.id} resources cleaned up`);
  
  // Clean up the worktree root directory for this plan
  // Note: spec.worktreeRoot uses internal UUID for consistency
  const internalId = (spec as any)._internalId || spec.id;
  const worktreeRoot = path.join(repoPath, spec.worktreeRoot || `.worktrees/${internalId}`);
  log.debug(`Cleaning up worktree root: ${worktreeRoot}`);
  await cleanupWorktreeRoot(worktreeRoot);
  
  // Also clean up any temporary merge worktrees that may have been left behind
  const mergeWorktreeDir = path.join(repoPath, '.worktrees');
  try {
    const entries = await fs.promises.readdir(mergeWorktreeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('_merge_')) {
        const mergePath = path.join(mergeWorktreeDir, entry.name);
        log.debug(`Cleaning up leftover merge worktree: ${mergePath}`);
        try {
          await git.worktrees.removeSafe(repoPath, mergePath, { force: true });
        } catch {
          await fs.promises.rm(mergePath, { recursive: true, force: true }).catch(() => {});
        }
      }
    }
  } catch {
    // .worktrees dir doesn't exist, that's fine
  }
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
