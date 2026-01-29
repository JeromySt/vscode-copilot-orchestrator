/**
 * @fileoverview MCP (Model Context Protocol) related VS Code commands.
 * 
 * Contains command handlers for MCP server management and configuration.
 * 
 * @module commands/mcpCommands
 */

import * as vscode from 'vscode';

// ============================================================================
// MCP COMMAND REGISTRATION
// ============================================================================

/**
 * Register MCP-related commands with VS Code.
 * 
 * @param context - Extension context for subscription management
 */
export function registerMcpCommands(context: vscode.ExtensionContext): void {
  // How to Connect - Copy connection details to clipboard
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.mcp.howToConnect', async () => {
      const cfg = vscode.workspace.getConfiguration('copilotOrchestrator.mcp');
      const host = String(cfg.get('host') || 'localhost');
      const port = Number(cfg.get('port') || 39219);

      const snippet = `Local MCP Orchestrator is running.
Tools available:
- orchestrator.job.create / orchestrator.job.status
- orchestrator.plan.create / orchestrator.plan.status / orchestrator.plan.cancel
MCP Endpoint: http://${host}:${port}/mcp
HTTP API: http://${host}:${port}`;

      await vscode.env.clipboard.writeText(snippet);
      vscode.window.showInformationMessage('MCP connection details copied to clipboard.');
    })
  );

  // Configure MCP Server - Prompt user for registration
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.mcp.configure', async () => {
      await promptMcpServerRegistration(context);
    })
  );
}

// ============================================================================
// MCP REGISTRATION PROMPTS
// ============================================================================

/**
 * Prompt the user to register the MCP server with GitHub Copilot.
 * Guides users through the setup process for Copilot integration.
 * 
 * @param context - Extension context for storing prompt state
 */
export async function promptMcpServerRegistration(
  context: vscode.ExtensionContext
): Promise<void> {
  // Check if user has already been prompted
  const hasPrompted = context.globalState.get<boolean>('mcpServerPrompted', false);
  if (hasPrompted) return;

  // Check if MCP is enabled in extension settings
  const mcpConfig = vscode.workspace.getConfiguration('copilotOrchestrator.mcp');
  if (!mcpConfig.get<boolean>('enabled', true)) return;

  const host = mcpConfig.get<string>('host', 'localhost');
  const port = mcpConfig.get<number>('port', 39219);

  // Show prompt with options
  const choice = await vscode.window.showInformationMessage(
    'Would you like to register the Copilot Orchestrator as an MCP server for GitHub Copilot?',
    'Yes, Register',
    'Skip for Now',
    'Never Ask Again'
  );

  if (choice === 'Yes, Register') {
    await showRegistrationInstructions(host, port);
    await context.globalState.update('mcpServerPrompted', true);
  } else if (choice === 'Never Ask Again') {
    await context.globalState.update('mcpServerPrompted', true);
  }
  // 'Skip for Now' - don't update state, will ask again on next activation
}

/**
 * Show detailed instructions for registering the MCP server.
 * Offers a direct "Start Server" button that attempts to start the MCP server directly.
 * 
 * @param host - MCP server host address
 * @param port - MCP server port number
 */
async function showRegistrationInstructions(host: string, port: number): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    'Copilot Orchestrator MCP server is ready! Click "Start Server" to enable it for GitHub Copilot Chat.',
    'Start Server',
    'Open MCP List',
    'Later'
  );

  if (choice === 'Start Server') {
    // Try to start the MCP server directly using VS Code's command
    // The server ID must match what we registered in package.json
    try {
      await vscode.commands.executeCommand(
        'workbench.action.chat.startMcpServer', 
        'copilot-orchestrator.mcp-server'
      );
      vscode.window.showInformationMessage('Copilot Orchestrator MCP server started! You can now use orchestrator tools in Copilot Chat.');
    } catch (error: any) {
      // If direct start fails, fall back to opening the MCP list
      console.warn('Direct MCP start failed, falling back to list:', error);
      await vscode.commands.executeCommand('workbench.action.chat.listMcpServers');
    }
  } else if (choice === 'Open MCP List') {
    await vscode.commands.executeCommand('workbench.action.chat.listMcpServers');
  }
}
