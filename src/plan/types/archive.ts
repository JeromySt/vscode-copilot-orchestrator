/**
 * @fileoverview Archive Types
 *
 * Defines types for plan archiving functionality, including archive results
 * and configuration options.
 *
 * @module plan/types/archive
 */

/**
 * Result of archiving a plan.
 * Contains details about resources that were cleaned up during the archive process.
 */
export interface ArchiveResult {
  /** Plan identifier that was archived */
  planId: string;
  
  /** Whether the archive operation succeeded */
  success: boolean;
  
  /** Worktree paths that were removed during archiving */
  cleanedWorktrees: string[];
  
  /** Branch names that were deleted during archiving */
  cleanedBranches: string[];
  
  /** Error message if the operation failed */
  error?: string;
}

/**
 * Configuration options for archiving a plan.
 */
export interface ArchiveOptions {
  /** Whether to force-delete worktrees even if they have uncommitted changes (default: false) */
  force?: boolean;
  
  /** Whether to also delete remote branches (default: false) */
  deleteRemoteBranches?: boolean;
}
