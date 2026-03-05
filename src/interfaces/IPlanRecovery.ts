/**
 * @fileoverview Plan recovery service.
 * Recovers plans from canceled or failed state by:
 * A) Recovering the targetBranch at its initial commit
 * B) For canceled/failed plans: recovering worktree states from the deepest
 *    successfully-completed job(s) using git rev-parse and DAG status
 * All recovered plans enter 'paused' state.
 *
 * @module interfaces/IPlanRecovery
 */

import type { RecoveryResult, RecoveryOptions, NodeRecoveryInfo } from '../plan/types/recovery';

export interface IPlanRecovery {
  /**
   * Recover a plan from canceled or failed state.
   * - Recovers targetBranch at initial commit (always)
   * - Recovers worktrees from deepest successful nodes (for canceled/failed plans)
   * - Uses copilot CLI/agent for recovery orchestration
   * - Places plan in 'paused' state after recovery
   *
   * @param planId - The plan to recover
   * @param options - Recovery options
   * @returns Result with details of recovered resources
   */
  recover(planId: string, options?: RecoveryOptions): Promise<RecoveryResult>;

  /**
   * Check if a plan can be recovered.
   * Only canceled or failed plans can be recovered.
   */
  canRecover(planId: string): boolean;

  /**
   * Analyze a plan's DAG to determine which nodes can be recovered.
   * Uses git rev-parse to check commit existence and DAG status for
   * work completion status.
   *
   * @param planId - The plan to analyze
   * @returns Recovery info for each node in the plan
   */
  analyzeRecoverableNodes(planId: string): Promise<NodeRecoveryInfo[]>;
}
