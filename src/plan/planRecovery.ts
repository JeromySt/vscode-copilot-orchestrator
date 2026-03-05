/**
 * @fileoverview Plan Recovery Service
 * 
 * Recovers plans from canceled or failed state by:
 * A) Recovering the targetBranch at its initial commit
 * B) For canceled/failed plans: recovering worktree states from the deepest
 *    successfully-completed job(s) using git rev-parse and DAG status
 * All recovered plans enter 'paused' state.
 * 
 * @module plan/planRecovery
 */

import * as path from 'path';
import { Logger } from '../core/logger';
import type { IPlanRecovery } from '../interfaces/IPlanRecovery';
import type { IGitOperations } from '../interfaces/IGitOperations';
import type { IPlanRunner } from '../interfaces/IPlanRunner';
import type { IPlanRepository } from '../interfaces/IPlanRepository';
import type { ICopilotRunner } from '../interfaces/ICopilotRunner';
import type { RecoveryResult, RecoveryOptions, NodeRecoveryInfo } from './types/recovery';
import type { PlanInstance, NodeStatus } from './types';

const log = Logger.for('plan');

/**
 * Recovers plans from canceled or failed state.
 * 
 * Implements the IPlanRecovery interface, providing:
 * - Target branch recovery at initial commit
 * - Worktree recovery from successful nodes (for canceled/failed plans)
 * - Transition to 'paused' state after recovery
 * - Optional Copilot agent verification
 */
export class PlanRecovery implements IPlanRecovery {
  constructor(
    private readonly _planRunner: IPlanRunner,
    private readonly _planRepo: IPlanRepository,
    private readonly _git: IGitOperations,
    private readonly _copilot: ICopilotRunner
  ) {}

  /**
   * Recover a plan from canceled or failed state.
   */
  async recover(planId: string, options?: RecoveryOptions): Promise<RecoveryResult> {
    log.info('Starting plan recovery', { planId, options });
    
    const plan = this._planRunner.get(planId);
    if (!plan) {
      return {
        planId,
        success: false,
        recoveredBranch: '',
        recoveredWorktrees: [],
        recoveredNodes: [],
        error: 'Plan not found'
      };
    }
    
    if (!this.canRecover(planId)) {
      const statusInfo = this._planRunner.getStatus(planId);
      const status = statusInfo?.status || 'unknown';
      return {
        planId,
        success: false,
        recoveredBranch: '',
        recoveredWorktrees: [],
        recoveredNodes: [],
        error: `Cannot recover plan with status '${status}'`
      };
    }

    const repoPath = plan.repoPath;
    const targetBranch = plan.targetBranch || plan.baseBranch;  // Fallback to baseBranch if targetBranch not set
    const baseBranch = plan.baseBranch;
    const recoveredWorktrees: string[] = [];
    const recoveredNodes: string[] = [];

    try {
      // STEP A: Always recover the targetBranch at initial commit
      // The targetBranch may have been deleted or may exist but be stale (canceled/failed)
      log.info('Recovering target branch', { planId, targetBranch, baseBranch });
      
      // Get the base branch commit (the initial commit for the target branch)
      const baseCommit = await this._git.repository.resolveRef(baseBranch, repoPath);
      if (!baseCommit) {
        return {
          planId,
          success: false,
          recoveredBranch: targetBranch,
          recoveredWorktrees: [],
          recoveredNodes: [],
          error: `Base branch '${baseBranch}' not found`
        };
      }
      
      // Create or reset target branch to base commit
      await this._git.branches.createOrReset(targetBranch, baseCommit, repoPath);
      log.info('Target branch recovered', { planId, targetBranch, baseCommit });

      // STEP B: For canceled/failed plans, recover worktrees from deepest successful nodes
      const statusInfo = this._planRunner.getStatus(planId);
      const wasCanceled = statusInfo?.status === 'canceled' || statusInfo?.status === 'failed';
      
      if (wasCanceled) {
        log.info('Recovering worktrees for canceled/failed plan', { planId });
        
        // Analyze which nodes completed successfully
        const nodeInfos = await this.analyzeRecoverableNodes(planId);
        
        // Find nodes where wasSuccessful=true and commitHash exists
        // These are nodes that completed successfully with recoverable commits
        const successfulNodes = nodeInfos.filter(n => n.wasSuccessful && n.commitHash);
        
        for (const nodeInfo of successfulNodes) {
          try {
            // Verify the commit still exists in the repo
            const commitExists = await this._verifyCommit(repoPath, nodeInfo.commitHash!);
            if (!commitExists) {
              log.warn('Commit no longer exists, skipping node recovery', {
                planId, nodeId: nodeInfo.nodeId, commitHash: nodeInfo.commitHash
              });
              continue;
            }
            
            // Create a new worktree for this node at the recovered commit
            const worktreePath = this._getWorktreePath(plan, nodeInfo.nodeId);
            
            // Path validation (security)
            const resolvedPath = path.resolve(worktreePath);
            const repoPathNorm = path.resolve(repoPath);
            if (!resolvedPath.startsWith(repoPathNorm + path.sep)) {
              log.error('Path traversal blocked in recovery', { planId, nodeId: nodeInfo.nodeId, worktreePath });
              continue;
            }
            
            // Create detached worktree at the successful commit
            await this._git.worktrees.createOrReuseDetached(repoPath, worktreePath, nodeInfo.commitHash!);
            recoveredWorktrees.push(worktreePath);
            recoveredNodes.push(nodeInfo.nodeId);
            log.info('Recovered worktree for node', {
              planId, nodeId: nodeInfo.nodeId, commitHash: nodeInfo.commitHash, worktreePath
            });
          } catch (err: any) {
            log.error('Failed to recover worktree for node', {
              planId, nodeId: nodeInfo.nodeId, error: err.message
            });
          }
        }
        
        // Use Copilot CLI agent to verify and fix any recovery issues
        if (options?.useCopilotAgent && recoveredNodes.length > 0) {
          await this._runRecoveryAgent(plan, recoveredNodes, recoveredWorktrees);
        }
      }

      // STEP C: Transition plan to 'paused' state
      await this._transitionToPaused(planId);
      
      log.info('Plan recovery complete', {
        planId,
        recoveredBranch: targetBranch,
        recoveredWorktrees: recoveredWorktrees.length,
        recoveredNodes: recoveredNodes.length
      });
      
      return {
        planId,
        success: true,
        recoveredBranch: targetBranch,
        recoveredWorktrees,
        recoveredNodes
      };
    } catch (err: any) {
      log.error('Plan recovery failed', { planId, error: err.message });
      return {
        planId,
        success: false,
        recoveredBranch: targetBranch,
        recoveredWorktrees,
        recoveredNodes,
        error: err.message
      };
    }
  }

  /**
   * Check if a plan can be recovered.
   * Only canceled or failed plans can be recovered.
   */
  canRecover(planId: string): boolean {
    const statusInfo = this._planRunner.getStatus(planId);
    if (!statusInfo) {
      return false;
    }
    return statusInfo.status === 'canceled' || statusInfo.status === 'failed';
  }

  /**
   * Analyze a plan's DAG to determine which nodes can be recovered.
   * Uses git rev-parse to check commit existence and DAG status for
   * work completion status.
   */
  async analyzeRecoverableNodes(planId: string): Promise<NodeRecoveryInfo[]> {
    const plan = this._planRunner.get(planId);
    if (!plan) {
      return [];
    }
    
    const results: NodeRecoveryInfo[] = [];
    const repoPath = plan.spec.repoPath;
    const sm = this._planRunner.getStateMachine(planId);
    
    for (const [nodeId, jobNode] of plan.jobs) {
      // Skip the SV (snapshot validation) node
      if (nodeId.includes('__sv')) {
        continue;
      }
      
      // Get the node's status from the state machine
      const nodeStatus = sm?.getNodeStatus(nodeId);
      const wasSuccessful = nodeStatus === 'succeeded';
      
      // Get the commit hash for this node's work
      let commitHash: string | null = null;
      if (wasSuccessful) {
        // Try to get commit hash from node state
        const nodeState = plan.nodeStates.get(nodeId);
        if (nodeState?.completedCommit) {
          commitHash = nodeState.completedCommit;
        } else {
          // Fallback: check attempt records for commit hash
          try {
            const attempts = this._planRunner.getNodeAttempts(planId, nodeId);
            if (attempts && attempts.length > 0) {
              // Find the last successful attempt
              const successfulAttempt = attempts
                .reverse()
                .find(a => a.status === 'succeeded' && a.completedCommit);
              if (successfulAttempt) {
                commitHash = successfulAttempt.completedCommit || null;
              }
            }
          } catch (err: any) {
            log.warn('Could not retrieve attempts for node', { planId, nodeId, error: err.message });
          }
        }
        
        // Final fallback: try to resolve from worktree
        if (!commitHash) {
          try {
            const worktreePath = this._getWorktreePath(plan, nodeId);
            commitHash = await this._git.worktrees.getHeadCommit(worktreePath);
          } catch {
            // Worktree may not exist anymore
          }
        }
      }
      
      results.push({
        nodeId,
        commitHash,
        wasSuccessful,
        dagStatus: nodeStatus || 'unknown',
        dependencies: jobNode.dependencies || []
      });
    }
    
    return results;
  }

  /**
   * Verify a commit exists in the repo using git rev-parse
   */
  private async _verifyCommit(repoPath: string, commitHash: string): Promise<boolean> {
    try {
      const resolved = await this._git.repository.resolveRef(commitHash, repoPath);
      return !!resolved;
    } catch {
      return false;
    }
  }

  /**
   * Get worktree path for a node (matches execution engine pattern)
   */
  private _getWorktreePath(plan: PlanInstance, nodeId: string): string {
    const repoPath = plan.repoPath;
    const worktreeRoot = plan.worktreeRoot || '.worktrees';
    const base = path.isAbsolute(worktreeRoot) ? worktreeRoot : path.join(repoPath, worktreeRoot);
    return path.join(base, plan.id, nodeId);
  }

  /**
   * Run Copilot CLI agent to verify and finalize recovery
   * 
   * Currently stubbed - can be implemented when agent recovery is needed.
   */
  private async _runRecoveryAgent(plan: PlanInstance, nodeIds: string[], worktreePaths: string[]): Promise<void> {
    try {
      log.info('Running recovery agent', { planId: plan.id, nodeCount: nodeIds.length });
      // Future implementation:
      // 1. Check each worktree's git status
      // 2. Verify compilation/build still works
      // 3. Report any issues
      // This would use this._copilot.run() with recovery-specific instructions
    } catch (err: any) {
      log.warn('Recovery agent failed (non-fatal)', { planId: plan.id, error: err.message });
    }
  }

  /**
   * Transition plan from canceled/failed to paused
   * 
   * Uses IPlanRunner.pause() which:
   * 1. Sets plan.isPaused = true
   * 2. Records pause in state history and pause history
   * 3. Persists the plan state
   * 4. Emits planUpdated event for UI refresh
   */
  private async _transitionToPaused(planId: string): Promise<void> {
    try {
      const success = this._planRunner.pause(planId);
      if (!success) {
        log.warn('Failed to transition plan to paused', { planId });
      } else {
        log.info('Plan transitioned to paused state', { planId });
      }
    } catch (err: any) {
      log.error('Error transitioning plan to paused', { planId, error: err.message });
      throw err;
    }
  }
}
