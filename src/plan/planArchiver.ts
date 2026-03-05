/**
 * @fileoverview Plan Archiver Service
 *
 * Archives completed/canceled plans by preserving their state/logs
 * while cleaning up git worktrees and target branches to reduce
 * repository clutter.
 *
 * @module plan/planArchiver
 */

import * as path from 'path';
import { Logger } from '../core/logger';
import type { IPlanArchiver } from '../interfaces/IPlanArchiver';
import type { IGitOperations } from '../interfaces/IGitOperations';
import type { IPlanRunner } from '../interfaces/IPlanRunner';
import type { IPlanRepository } from '../interfaces/IPlanRepository';
import type { ArchiveResult, ArchiveOptions } from './types/archive';
import type { PlanStatus } from './types/plan';

const log = Logger.for('plan-archiver');

export class PlanArchiver implements IPlanArchiver {
  constructor(
    private readonly _planRunner: IPlanRunner,
    private readonly _planRepo: IPlanRepository,
    private readonly _git: IGitOperations
  ) {}

  async archive(planId: string, options?: ArchiveOptions): Promise<ArchiveResult> {
    log.info('Archiving plan', { planId, options });
    
    const plan = this._planRunner.get(planId);
    if (!plan) {
      return { 
        planId, 
        success: false, 
        cleanedWorktrees: [], 
        cleanedBranches: [], 
        error: 'Plan not found' 
      };
    }
    
    if (!this.canArchive(planId)) {
      const currentStatus = this._getStatus(planId);
      return { 
        planId, 
        success: false, 
        cleanedWorktrees: [], 
        cleanedBranches: [], 
        error: `Plan status '${currentStatus}' does not support archiving` 
      };
    }
    
    const cleanedWorktrees: string[] = [];
    const cleanedBranches: string[] = [];
    const repoPath = plan.spec.repoPath || plan.repoPath;
    
    try {
      // Validate repo path to prevent path traversal
      const normalizedRepoPath = path.resolve(repoPath);
      if (!normalizedRepoPath || normalizedRepoPath === '.') {
        throw new Error('Invalid repository path');
      }
      
      // 1. Clean up all worktrees for this plan's jobs
      for (const [nodeId, jobNode] of plan.jobs) {
        const nodeState = plan.nodeStates.get(nodeId);
        const worktreePath = nodeState?.worktreePath || this._getWorktreePath(plan, nodeId);
        
        if (worktreePath) {
          // Validate worktree path (must be inside repo or worktree root)
          const normalizedWorktreePath = path.resolve(worktreePath);
          const worktreeRoot = path.resolve(plan.worktreeRoot);
          
          if (!normalizedWorktreePath.startsWith(normalizedRepoPath + path.sep) && 
              !normalizedWorktreePath.startsWith(worktreeRoot + path.sep)) {
            log.warn('Skipping worktree outside safe paths', { 
              planId, 
              nodeId, 
              worktreePath: normalizedWorktreePath 
            });
            continue;
          }
          
          try {
            const isValid = await this._git.worktrees.isValid(worktreePath);
            if (isValid) {
              const removed = await this._git.worktrees.removeSafe(
                repoPath, 
                worktreePath, 
                { force: options?.force }
              );
              
              if (removed) {
                cleanedWorktrees.push(worktreePath);
                log.info('Removed worktree', { planId, nodeId, worktreePath });
              }
            }
          } catch (err: any) {
            log.warn('Failed to remove worktree', { 
              planId, 
              nodeId, 
              worktreePath, 
              error: err.message 
            });
          }
        }
      }
      
      // 2. Clean up snapshot worktree if it exists
      if (plan.snapshot?.worktreePath) {
        const snapshotPath = plan.snapshot.worktreePath;
        const normalizedSnapshotPath = path.resolve(snapshotPath);
        const worktreeRoot = path.resolve(plan.worktreeRoot);
        
        if (normalizedSnapshotPath.startsWith(normalizedRepoPath + path.sep) || 
            normalizedSnapshotPath.startsWith(worktreeRoot + path.sep)) {
          try {
            const isValid = await this._git.worktrees.isValid(snapshotPath);
            if (isValid) {
              const removed = await this._git.worktrees.removeSafe(
                repoPath, 
                snapshotPath, 
                { force: options?.force }
              );
              
              if (removed) {
                cleanedWorktrees.push(snapshotPath);
                log.info('Removed snapshot worktree', { planId, snapshotPath });
              }
            }
          } catch (err: any) {
            log.warn('Failed to remove snapshot worktree', { 
              planId, 
              snapshotPath, 
              error: err.message 
            });
          }
        }
      }
      
      // 3. Prune stale worktree references from git
      try {
        await this._git.worktrees.prune(repoPath);
        log.debug('Pruned worktree references', { planId });
      } catch (err: any) {
        log.warn('Failed to prune worktrees', { planId, error: err.message });
      }
      
      // 4. Clean up target branch (local)
      const targetBranch = plan.targetBranch || plan.spec.targetBranch;
      if (targetBranch) {
        try {
          const branchExists = await this._git.branches.exists(targetBranch, repoPath);
          if (branchExists) {
            // Safety: never delete the default branch
            const isDefault = await this._git.branches.isDefaultBranch(targetBranch, repoPath);
            if (!isDefault) {
              const deleted = await this._git.branches.deleteLocal(repoPath, targetBranch);
              if (deleted) {
                cleanedBranches.push(targetBranch);
                log.info('Deleted local target branch', { planId, targetBranch });
              }
            } else {
              log.info('Skipped deletion of default branch', { planId, targetBranch });
            }
          }
        } catch (err: any) {
          log.warn('Failed to delete target branch', { planId, targetBranch, error: err.message });
        }
      }
      
      // 5. Clean up snapshot branch if it exists
      if (plan.snapshot?.branch) {
        const snapshotBranch = plan.snapshot.branch;
        try {
          const branchExists = await this._git.branches.exists(snapshotBranch, repoPath);
          if (branchExists) {
            const deleted = await this._git.branches.deleteLocal(repoPath, snapshotBranch, { force: true });
            if (deleted) {
              cleanedBranches.push(snapshotBranch);
              log.info('Deleted snapshot branch', { planId, snapshotBranch });
            }
          }
        } catch (err: any) {
          log.warn('Failed to delete snapshot branch', { planId, snapshotBranch, error: err.message });
        }
      }
      
      // 6. Optionally clean up remote branches
      if (options?.deleteRemoteBranches && targetBranch) {
        try {
          const remoteExists = await this._git.branches.remoteExists(targetBranch, repoPath);
          if (remoteExists) {
            await this._git.branches.deleteRemote(repoPath, targetBranch);
            log.info('Deleted remote target branch', { planId, targetBranch });
          }
        } catch (err: any) {
          log.warn('Failed to delete remote branch', { planId, targetBranch, error: err.message });
        }
      }
      
      // 7. Update plan status to 'archived'
      await this._markAsArchived(planId);
      
      log.info('Plan archived successfully', {
        planId,
        cleanedWorktrees: cleanedWorktrees.length,
        cleanedBranches: cleanedBranches.length
      });
      
      return { planId, success: true, cleanedWorktrees, cleanedBranches };
    } catch (err: any) {
      log.error('Archive failed', { planId, error: err.message });
      return { 
        planId, 
        success: false, 
        cleanedWorktrees, 
        cleanedBranches, 
        error: err.message 
      };
    }
  }

  canArchive(planId: string): boolean {
    const status = this._getStatus(planId);
    return status === 'succeeded' || status === 'partial' || status === 'failed' || status === 'canceled';
  }

  getArchivedPlans(): import('./types/plan').PlanInstance[] {
    return this._planRunner.getAll().filter(p => {
      const status = this._getStatus(p.id);
      return status === 'archived';
    });
  }

  isArchived(planId: string): boolean {
    return this._getStatus(planId) === 'archived';
  }

  /**
   * Get the computed status of a plan.
   */
  private _getStatus(planId: string): PlanStatus {
    const statusInfo = this._planRunner.getStatus(planId);
    if (!statusInfo) {
      return 'canceled'; // Non-existent plan treated as terminal
    }
    return statusInfo.status;
  }

  /**
   * Get the worktree path for a job node.
   * Derives from plan spec's worktreeRoot + planId/nodeId pattern.
   */
  private _getWorktreePath(plan: any, nodeId: string): string {
    const repoPath = plan.spec.repoPath || plan.repoPath;
    const worktreeRoot = plan.worktreeRoot || plan.spec.worktreeRoot || '.worktrees';
    const base = path.isAbsolute(worktreeRoot) ? worktreeRoot : path.join(repoPath, worktreeRoot);
    return path.join(base, plan.id, nodeId);
  }

  /**
   * Mark plan as archived in persistence.
   * Updates the plan's stateHistory and persists to disk.
   */
  private async _markAsArchived(planId: string): Promise<void> {
    const plan = this._planRunner.get(planId);
    if (!plan) {
      throw new Error(`Plan ${planId} not found`);
    }
    
    // Add a state transition to 'archived'
    if (!plan.stateHistory) {
      plan.stateHistory = [];
    }
    
    const currentStatus = this._getStatus(planId);
    plan.stateHistory.push({
      from: currentStatus,
      to: 'archived',
      timestamp: Date.now(),
      reason: 'user-archived'
    });
    
    // Persist the updated state
    await this._planRepo.saveState(plan);
    
    log.debug('Marked plan as archived', { planId });
  }
}
