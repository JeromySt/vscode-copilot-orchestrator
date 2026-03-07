/**
 * @fileoverview Bulk command logic abstracted from VS Code dependencies.
 * 
 * Contains pure business logic for bulk operations on multiple plans
 * without direct VS Code API coupling. Uses dependency injection for
 * testability and clean separation of concerns.
 * 
 * @module commands/bulkCommandLogic
 */

import { Logger } from '../core/logger';
import type { IBulkPlanActions, BulkActionType } from '../interfaces/IBulkPlanActions';
import type { IDialogService } from '../interfaces/IDialogService';

const log = Logger.for('ui');

/**
 * Prompt for confirmation before destructive bulk actions.
 * 
 * @param dialog - Dialog service for user prompts
 * @param action - The action type being performed
 * @param count - Number of plans being acted on
 * @returns True if user confirmed, false if canceled
 */
export async function confirmBulkAction(
  dialog: IDialogService,
  action: BulkActionType,
  count: number
): Promise<boolean> {
  if (action === 'delete') {
    const answer = await dialog.showWarning(
      `Delete ${count} plan${count > 1 ? 's' : ''}? This cannot be undone.`,
      { modal: true },
      'Delete', 'Cancel'
    );
    return answer === 'Delete';
  }
  if (action === 'cancel') {
    const answer = await dialog.showWarning(
      `Cancel ${count} running plan${count > 1 ? 's' : ''}?`,
      { modal: true },
      'Cancel Plans', 'Keep Running'
    );
    return answer === 'Cancel Plans';
  }
  // Non-destructive actions (pause, resume, retry, finalize) don't need confirmation
  return true;
}

/**
 * Execute a bulk action on multiple plans with confirmation and result feedback.
 * 
 * @param bulkActions - The bulk actions service
 * @param dialog - Dialog service for user prompts
 * @param action - The action to perform
 * @param planIds - Array of plan IDs to act on
 */
export async function executeBulkCommand(
  bulkActions: IBulkPlanActions,
  dialog: IDialogService,
  action: BulkActionType,
  planIds: string[]
): Promise<void> {
  if (!planIds || planIds.length === 0) {
    await dialog.showWarning('No plans selected');
    return;
  }
  
  log.info(`Executing bulk ${action}`, { planCount: planIds.length });
  
  // Confirm destructive actions
  const confirmed = await confirmBulkAction(dialog, action, planIds.length);
  if (!confirmed) {
    log.info(`Bulk ${action} canceled by user`);
    return;
  }
  
  // Execute the bulk action
  const results = await bulkActions.executeBulkAction(action, planIds);
  
  // Summarize results
  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  
  if (failed === 0) {
    await dialog.showInfo(`Bulk ${action}: ${succeeded} plan${succeeded > 1 ? 's' : ''} succeeded`);
  } else if (succeeded === 0) {
    await dialog.showError(`Bulk ${action}: All ${failed} plan${failed > 1 ? 's' : ''} failed`);
  } else {
    await dialog.showWarning(
      `Bulk ${action}: ${succeeded} succeeded, ${failed} failed`
    );
  }
  
  // Log individual failures for debugging
  for (const result of results) {
    if (!result.success && result.error) {
      log.warn(`Bulk ${action} failed for plan`, { planId: result.planId, error: result.error });
    }
  }
}
