/**
 * @fileoverview Utility VS Code commands.
 * 
 * Contains command handlers for utility operations like model discovery.
 * 
 * @module commands/utilityCommands
 */

import * as vscode from 'vscode';

// ============================================================================
// UTILITY COMMAND REGISTRATION
// ============================================================================

/**
 * Register utility commands with VS Code.
 * 
 * @param context - Extension context for subscription management
 */
export function registerUtilityCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('copilotOrchestrator.refreshModels', async () => {
      const { refreshModelCache } = await import('../agent/modelDiscovery');
      const result = await refreshModelCache();
      if (result.models.length > 0) {
        vscode.window.showInformationMessage(
          `Discovered ${result.models.length} models from Copilot CLI`
        );
      } else {
        vscode.window.showWarningMessage(
          'Could not discover models. Is Copilot CLI installed?'
        );
      }
    })
  );
}
