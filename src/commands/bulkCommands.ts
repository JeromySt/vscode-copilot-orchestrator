/**
 * @fileoverview Bulk plan action VS Code commands.
 * 
 * Registers commands for multi-select operations on plans.
 * Commands are invoked from the webview UI with an array of plan IDs.
 * 
 * @module commands/bulkCommands
 */

import * as vscode from 'vscode';
import { Logger } from '../core/logger';
import type { IBulkPlanActions, BulkActionType } from '../interfaces/IBulkPlanActions';

const log = Logger.for('bulk-plan-actions');

/**
 * Register bulk action commands with VS Code.
 * 
 * @param context - Extension context for subscription management
 * @param bulkActions - The bulk actions service instance
 */
export function registerBulkCommands(
  context: vscode.ExtensionContext,
  bulkActions: IBulkPlanActions
): void {
  
  // Helper to execute a bulk action and show results
  async function executeBulk(action: BulkActionType, planIds: string[]): Promise<void> {
    if (!planIds || planIds.length === 0) {
      vscode.window.showWarningMessage('No plans selected');
      return;
    }
    
    log.info(`Executing bulk ${action}`, { planCount: planIds.length });
    
    const results = await bulkActions.executeBulkAction(action, planIds);
    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    
    if (failed === 0) {
      vscode.window.showInformationMessage(`Bulk ${action}: ${succeeded} plan(s) succeeded`);
    } else if (succeeded === 0) {
      vscode.window.showErrorMessage(`Bulk ${action}: All ${failed} plan(s) failed`);
    } else {
      vscode.window.showWarningMessage(
        `Bulk ${action}: ${succeeded} succeeded, ${failed} failed`
      );
    }
    
    // Log individual failures
    for (const result of results) {
      if (!result.success && result.error) {
        log.warn(`Bulk ${action} failed for plan`, { planId: result.planId, error: result.error });
      }
    }
  }
  
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'copilotOrchestrator.bulkDelete',
      async (planIds: string[]) => {
        const confirmed = await vscode.window.showWarningMessage(
          `Delete ${planIds.length} plan(s)?`,
          { modal: true },
          'Delete'
        );
        if (confirmed === 'Delete') {
          await executeBulk('delete', planIds);
        }
      }
    ),
    
    vscode.commands.registerCommand(
      'copilotOrchestrator.bulkCancel',
      async (planIds: string[]) => executeBulk('cancel', planIds)
    ),
    
    vscode.commands.registerCommand(
      'copilotOrchestrator.bulkPause',
      async (planIds: string[]) => executeBulk('pause', planIds)
    ),
    
    vscode.commands.registerCommand(
      'copilotOrchestrator.bulkResume',
      async (planIds: string[]) => executeBulk('resume', planIds)
    ),
    
    vscode.commands.registerCommand(
      'copilotOrchestrator.bulkRetry',
      async (planIds: string[]) => executeBulk('retry', planIds)
    ),
    
    vscode.commands.registerCommand(
      'copilotOrchestrator.bulkFinalize',
      async (planIds: string[]) => {
        vscode.window.showWarningMessage('Bulk finalize is not yet implemented');
      }
    )
  );
  
  log.info('Bulk action commands registered');
}
