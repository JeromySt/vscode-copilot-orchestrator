/**
 * @fileoverview Plan archiving service interface.
 *
 * Archives completed/canceled plans by preserving their state/logs
 * while cleaning up git worktrees and target branches to reduce
 * repository clutter.
 *
 * @module interfaces/IPlanArchiver
 */

import type { ArchiveResult, ArchiveOptions } from '../plan/types/archive';
import type { PlanInstance } from '../plan/types/plan';

/**
 * Plan archiving service.
 * 
 * Provides functionality to archive plans that have completed execution,
 * preserving their state and logs while cleaning up associated git resources
 * (worktrees and branches) to reduce repository overhead.
 * 
 * Only plans in terminal states ('succeeded', 'failed', or 'canceled') can
 * be archived. Once archived, a plan cannot be executed or modified, but its
 * state and logs remain accessible for historical reference.
 * 
 * @example
 * ```typescript
 * const archiver = container.resolve<IPlanArchiver>(Tokens.IPlanArchiver);
 * 
 * if (archiver.canArchive(planId)) {
 *   const result = await archiver.archive(planId);
 *   console.log(`Cleaned ${result.cleanedWorktrees.length} worktrees`);
 * }
 * ```
 */
export interface IPlanArchiver {
  /**
   * Archive a plan: preserve state/logs, clean up worktrees and branches.
   * 
   * The archive process:
   * 1. Verifies the plan is in an archivable state (succeeded, failed, or canceled)
   * 2. Changes the plan status to 'archived'
   * 3. Removes all associated git worktrees
   * 4. Deletes target branches (both local and optionally remote)
   * 5. Preserves all state data, logs, and execution history
   * 
   * @param planId - The plan to archive
   * @param options - Archive configuration options
   * @returns Result with details of cleaned resources and any errors
   * @throws Never throws - returns error in result.error field
   */
  archive(planId: string, options?: ArchiveOptions): Promise<ArchiveResult>;

  /**
   * Check if a plan can be archived based on its current status.
   * 
   * A plan can be archived if it is in one of the terminal states:
   * - 'succeeded' - all nodes completed successfully
   * - 'failed' - one or more nodes failed
   * - 'canceled' - user canceled the plan
   * 
   * Plans in 'scaffolding', 'pending', 'running', or 'paused' states
   * cannot be archived.
   * 
   * @param planId - The plan to check
   * @returns true if the plan exists and is in an archivable state
   */
  canArchive(planId: string): boolean;

  /**
   * Get all archived plans.
   * 
   * Returns plan instances for all plans with status 'archived'.
   * Useful for displaying historical plans in the UI or generating reports.
   * 
   * @returns Array of archived plan instances (may be empty)
   */
  getArchivedPlans(): PlanInstance[];

  /**
   * Check if a plan is currently archived.
   * 
   * @param planId - The plan to check
   * @returns true if the plan exists and has status 'archived'
   */
  isArchived(planId: string): boolean;
}
