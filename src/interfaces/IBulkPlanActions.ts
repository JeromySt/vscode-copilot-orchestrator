/**
 * @fileoverview Bulk operations on multiple plans simultaneously.
 * Used by the plans view multi-select feature to apply actions to
 * a set of selected plans.
 */

export type BulkActionType = 'delete' | 'cancel' | 'pause' | 'resume' | 'retry' | 'finalize';

export interface BulkActionResult {
  planId: string;
  success: boolean;
  error?: string;
}

export interface IBulkPlanActions {
  /**
   * Execute a bulk action on multiple plans.
   * @param action - The action to perform
   * @param planIds - The plan IDs to act on
   * @returns Results for each plan, indicating success or failure
   */
  executeBulkAction(action: BulkActionType, planIds: string[]): Promise<BulkActionResult[]>;

  /**
   * Get which actions are valid for a set of plans based on their current states.
   * @param planIds - The plan IDs to check
   * @returns Map of action type to whether it's valid for ANY of the selected plans
   */
  getValidActions(planIds: string[]): Map<BulkActionType, boolean>;
}
