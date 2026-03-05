/**
 * @fileoverview PR lifecycle management commands.
 *
 * Commands for managing active pull requests.
 *
 * @module commands/prLifecycleCommands
 */

import * as vscode from 'vscode';
import { ActivePRPanel } from '../ui/panels/activePRPanel';
import type { ManagedPR } from '../plan/types/prLifecycle';

/**
 * Register PR lifecycle management commands.
 *
 * @param context - VS Code extension context.
 * @param getPRData - Function to fetch managed PR data.
 */
export function registerPRLifecycleCommands(
  context: vscode.ExtensionContext,
  getPRData: (id: string) => ManagedPR | undefined,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.showActivePR', (managedPRId: string) => {
      ActivePRPanel.createOrShow(
        context.extensionUri,
        managedPRId,
        getPRData,
      );
    }),

    vscode.commands.registerCommand('orchestrator.monitorPR', async (managedPRId: string) => {
      // TODO: Implement PR monitoring start
      vscode.window.showInformationMessage(`Starting monitoring for PR ${managedPRId} (not yet implemented)`);
    }),

    vscode.commands.registerCommand('orchestrator.pausePR', async (managedPRId: string) => {
      // TODO: Implement PR monitoring pause
      vscode.window.showInformationMessage(`Pausing monitoring for PR ${managedPRId} (not yet implemented)`);
    }),

    vscode.commands.registerCommand('orchestrator.promotePR', async (managedPRId: string) => {
      // TODO: Implement PR promotion (mark as ready for review)
      vscode.window.showInformationMessage(`Promoting PR ${managedPRId} (not yet implemented)`);
    }),

    vscode.commands.registerCommand('orchestrator.demotePR', async (managedPRId: string) => {
      // TODO: Implement PR demotion (convert to draft)
      vscode.window.showInformationMessage(`Converting PR ${managedPRId} to draft (not yet implemented)`);
    }),

    vscode.commands.registerCommand('orchestrator.abandonPR', async (managedPRId: string) => {
      // TODO: Implement PR abandonment (stop managing)
      vscode.window.showInformationMessage(`Abandoning PR ${managedPRId} (not yet implemented)`);
      // Close the panel after abandoning
      ActivePRPanel.closeForPR(managedPRId);
    }),

    vscode.commands.registerCommand('orchestrator.removePR', async (managedPRId: string) => {
      // TODO: Implement PR removal (delete from management)
      vscode.window.showInformationMessage(`Removing PR ${managedPRId} (not yet implemented)`);
      // Close the panel after removing
      ActivePRPanel.closeForPR(managedPRId);
    }),

    vscode.commands.registerCommand('orchestrator.adoptPR', async () => {
      // TODO: Implement PR adoption workflow
      const prNumber = await vscode.window.showInputBox({
        prompt: 'Enter PR number to adopt',
        placeHolder: '123',
      });
      if (!prNumber) {
        return;
      }
      vscode.window.showInformationMessage(`Adopting PR #${prNumber} (not yet implemented)`);
    }),
  );
}
