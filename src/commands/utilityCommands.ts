/**
 * @fileoverview Utility VS Code commands.
 * 
 * Contains VS Code command registration that delegates to pure business logic.
 * The actual command handling is in utilityCommandLogic.ts for testability.
 * 
 * @module commands/utilityCommands
 */

import * as vscode from 'vscode';
import { handleRefreshModels, handleRefreshCopilotCli, handleSetupCopilotCli } from './utilityCommandLogic';
import { VsCodeDialogService } from '../vscode/adapters';

/**
 * Register utility commands with VS Code.
 * 
 * @param context - Extension context for subscription management
 */
export function registerUtilityCommands(context: vscode.ExtensionContext): void {
  const dialog = new VsCodeDialogService();

  context.subscriptions.push(
    vscode.commands.registerCommand('copilotOrchestrator.refreshModels', async () => {
      await handleRefreshModels({ dialog });
    }),
    
    vscode.commands.registerCommand('copilotOrchestrator.refreshCopilotCli', async () => {
      await handleRefreshCopilotCli({ dialog });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('copilotOrchestrator.setupCopilotCli', async () => {
      await handleSetupCopilotCli({
        dialog,
        openTerminal: (name: string, command: string) => {
          const terminal = vscode.window.createTerminal({ name });
          terminal.show();
          terminal.sendText(command, true);
        },
      });
    })
  );
}
