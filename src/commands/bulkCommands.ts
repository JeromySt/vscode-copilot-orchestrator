/**
 * @fileoverview Bulk plan action VS Code commands.
 * 
 * Contains VS Code command registration that delegates to pure business logic.
 * The actual command handling is in bulkCommandLogic.ts for testability.
 * 
 * @module commands/bulkCommands
 */

import * as vscode from 'vscode';
import { executeBulkCommand } from './bulkCommandLogic';
import type { IBulkPlanActions } from '../interfaces/IBulkPlanActions';
import type { IDialogService } from '../interfaces/IDialogService';

/**
 * Register bulk action commands with VS Code.
 * 
 * @param context - Extension context for subscription management
 * @param bulkActions - The bulk actions service instance
 * @param dialog - Dialog service (injected, avoids direct VsCodeDialogService instantiation)
 */
export function registerBulkCommands(
  context: vscode.ExtensionContext,
  bulkActions: IBulkPlanActions,
  dialog: IDialogService
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'orchestrator.bulkDelete',
      async (planIds: string[]) => {
        await executeBulkCommand(bulkActions, dialog, 'delete', planIds);
      }
    ),
    
    vscode.commands.registerCommand(
      'orchestrator.bulkCancel',
      async (planIds: string[]) => {
        await executeBulkCommand(bulkActions, dialog, 'cancel', planIds);
      }
    ),
    
    vscode.commands.registerCommand(
      'orchestrator.bulkPause',
      async (planIds: string[]) => {
        await executeBulkCommand(bulkActions, dialog, 'pause', planIds);
      }
    ),
    
    vscode.commands.registerCommand(
      'orchestrator.bulkResume',
      async (planIds: string[]) => {
        await executeBulkCommand(bulkActions, dialog, 'resume', planIds);
      }
    ),
    
    vscode.commands.registerCommand(
      'orchestrator.bulkRetry',
      async (planIds: string[]) => {
        await executeBulkCommand(bulkActions, dialog, 'retry', planIds);
      }
    ),
    
    vscode.commands.registerCommand(
      'orchestrator.bulkFinalize',
      async (planIds: string[]) => {
        await executeBulkCommand(bulkActions, dialog, 'finalize', planIds);
      }
    )
  );
}
