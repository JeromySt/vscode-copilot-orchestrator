/**
 * @fileoverview MCP server registration utilities.
 * 
 * The MCP server auto-registers with VS Code via McpServerDefinitionProvider.
 * This module provides utilities for programmatically starting/checking the server.
 * 
 * @module mcp/mcpRegistration
 */

import * as vscode from 'vscode';

/**
 * State key for tracking whether user has seen the MCP intro message.
 * Stored in {@link vscode.ExtensionContext.globalState}.
 */
const PROMPTED_STATE_KEY = 'mcpServerPrompted';

/**
 * Show a one-time prompt explaining how to use the MCP server.
 * 
 * The MCP server auto-registers with VS Code via McpServerDefinitionProvider,
 * but users may need guidance on how to start it.
 *
 * @param context - VS Code extension context for state persistence.
 */
export async function promptMcpServerStart(
  context: vscode.ExtensionContext
): Promise<void> {
  // Check if already prompted
  const hasPrompted = context.globalState.get<boolean>(PROMPTED_STATE_KEY, false);
  if (hasPrompted) {return;}
  
  // Check if MCP is enabled
  const mcpConfig = vscode.workspace.getConfiguration('copilotOrchestrator.mcp');
  if (!mcpConfig.get<boolean>('enabled', true)) {return;}
  
  const choice = await vscode.window.showInformationMessage(
    'Copilot Orchestrator MCP server is available! Start it from "MCP: List Servers" to use orchestrator tools in Copilot Chat.',
    'Start Server',
    'List Servers',
    "Don't Show Again"
  );
  
  if (choice === 'Start Server') {
    try {
      await vscode.commands.executeCommand(
        'workbench.action.chat.startMcpServer', 
        'copilot-orchestrator.mcp-server'
      );
      vscode.window.showInformationMessage(
        'Copilot Orchestrator MCP server started! You can now use orchestrator tools in Copilot Chat.'
      );
    } catch (error: any) {
      // If direct start fails, fall back to opening the MCP list
      console.warn('Direct MCP start failed, falling back to list:', error);
      await vscode.commands.executeCommand('workbench.action.chat.listMcpServers');
    }
    await context.globalState.update(PROMPTED_STATE_KEY, true);
  } else if (choice === 'List Servers') {
    await vscode.commands.executeCommand('workbench.action.chat.listMcpServers');
    await context.globalState.update(PROMPTED_STATE_KEY, true);
  } else if (choice === "Don't Show Again") {
    await context.globalState.update(PROMPTED_STATE_KEY, true);
  }
  // Default (dismissed) - don't update state, will prompt again next time
}

/**
 * Attempt to start the MCP server programmatically.
 * 
 * Uses VS Code's `workbench.action.chat.startMcpServer` command.
 * Falls back to opening the MCP server list if the command fails.
 * 
 * @returns true if the server start command was executed successfully
 */
export async function startMcpServer(): Promise<boolean> {
  try {
    await vscode.commands.executeCommand(
      'workbench.action.chat.startMcpServer', 
      'copilot-orchestrator.mcp-server'
    );
    return true;
  } catch (error: any) {
    console.warn('Failed to start MCP server:', error);
    return false;
  }
}

/**
 * Open the MCP server list in VS Code.
 */
export async function openMcpServerList(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.chat.listMcpServers');
}

/**
 * Reset the registration prompt state so it will be shown again.
 *
 * Primarily useful for development/testing.
 *
 * @param context - VS Code extension context for state persistence.
 */
export async function resetMcpPromptState(
  context: vscode.ExtensionContext
): Promise<void> {
  await context.globalState.update(PROMPTED_STATE_KEY, false);
}
