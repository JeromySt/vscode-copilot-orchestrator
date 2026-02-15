/**
 * @fileoverview MCP (Model Context Protocol) related VS Code commands.
 * 
 * Contains VS Code command registration that delegates to pure business logic.
 * The actual command handling is in mcpCommandLogic.ts for testability.
 * 
 * @module commands/mcpCommands
 */

import * as vscode from 'vscode';
import { handleHowToConnect, handlePromptMcpStart, type CommandExecutor } from './mcpCommandLogic';
import { VsCodeDialogService, VsCodeClipboardService, VsCodeConfigProvider } from '../vscode/adapters';

/**
 * VS Code command executor implementation.
 */
class VsCodeCommandExecutor implements CommandExecutor {
  async executeCommand(command: string, ...args: any[]): Promise<void> {
    await vscode.commands.executeCommand(command, ...args);
  }
}

/**
 * Register MCP-related commands with VS Code.
 * 
 * @param context - Extension context for subscription management
 */
export function registerMcpCommands(context: vscode.ExtensionContext): void {
  const dialog = new VsCodeDialogService();
  const clipboard = new VsCodeClipboardService();
  const config = new VsCodeConfigProvider();
  const commandExecutor = new VsCodeCommandExecutor();

  // How to Connect - Show MCP server list or start server
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.mcp.howToConnect', async () => {
      const choice = await vscode.window.showInformationMessage(
        'The Copilot Orchestrator MCP server auto-registers with VS Code. Use "MCP: List Servers" to manage it.',
        'Start Server',
        'List Servers',
        'Copy Info'
      );
      
      await handleHowToConnect(choice as any, { dialog, clipboard, config }, commandExecutor);
    })
  );

  // Configure MCP Server - Start or list MCP servers
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.mcp.configure', async () => {
      await handlePromptMcpStart({ dialog, config }, commandExecutor);
    })
  );
}
