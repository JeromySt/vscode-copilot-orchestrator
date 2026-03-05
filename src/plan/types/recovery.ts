/**
 * @fileoverview Types for plan recovery from canceled or failed state.
 */

export interface RecoveryResult {
  planId: string;
  success: boolean;
  recoveredBranch: string;        // The recovered target branch
  recoveredWorktrees: string[];   // Worktree paths that were recreated
  recoveredNodes: string[];       // Node IDs recovered from successful commits
  error?: string;
}

export interface RecoveryOptions {
  /** Whether to recover using copilot CLI agent for complex recovery tasks */
  useCopilotAgent?: boolean;
}

export interface NodeRecoveryInfo {
  nodeId: string;
  /** The git commit hash for this node's deepest successful work */
  commitHash: string | null;
  /** Whether this node completed successfully */
  wasSuccessful: boolean;
  /** The work result status from the DAG */
  dagStatus: string;
  /** Dependencies that must be recovered first */
  dependencies: string[];
}
