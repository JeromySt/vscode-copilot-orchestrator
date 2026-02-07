/**
 * @fileoverview MCP (Model Context Protocol) related VS Code commands.
 * 
 * Contains command handlers for MCP server management and configuration.
 * The MCP server uses stdio transport and auto-registers with VS Code.
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
  // How to Connect - Show MCP server list or start server
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.mcp.howToConnect', async () => {
      const choice = await vscode.window.showInformationMessage(
        'The Copilot Orchestrator MCP server auto-registers with VS Code. Use "MCP: List Servers" to manage it.',
        'Start Server',
        'List Servers',
        'Copy Info'
      );
      
      if (choice === 'Start Server') {
        try {
          await vscode.commands.executeCommand(
            'workbench.action.chat.startMcpServer', 
            'copilot-orchestrator.mcp-server'
          );
          vscode.window.showInformationMessage('Copilot Orchestrator MCP server started!');
        } catch (error: any) {
          await vscode.commands.executeCommand('workbench.action.chat.listMcpServers');
        }
      } else if (choice === 'List Servers') {
        await vscode.commands.executeCommand('workbench.action.chat.listMcpServers');
      } else if (choice === 'Copy Info') {
        const snippet = `Copilot Orchestrator MCP Server

The MCP server automatically registers with VS Code using stdio transport.
No manual configuration needed - just use "MCP: List Servers" and start it.

Available tools:
- create_copilot_plan - Create a dependency graph of work
- create_copilot_job - Create a single job (plan with one node)
- get_copilot_plan_status - Get plan execution status
- list_copilot_plans - List all plans
- cancel_copilot_plan - Cancel a running plan
- And more...

To enable: Run "MCP: List Servers" and start "Copilot Orchestrator"`;
        await vscode.env.clipboard.writeText(snippet);
        vscode.window.showInformationMessage('MCP info copied to clipboard.');
      }
    })
  );

  // Configure MCP Server - Start or list MCP servers
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.mcp.configure', async () => {
      await promptMcpServerStart(context);
    })
  );
}

// ============================================================================
// MCP SERVER START PROMPTS
// ============================================================================

/**
 * Prompt the user to start the MCP server for GitHub Copilot.
 * The server auto-registers via McpServerDefinitionProvider - this just starts it.
 * 
 * @param context - Extension context for storing prompt state
 */
async function promptMcpServerStart(
  context: vscode.ExtensionContext
): Promise<void> {
  // Check if MCP is enabled in extension settings
  const mcpConfig = vscode.workspace.getConfiguration('copilotOrchestrator.mcp');
  if (!mcpConfig.get<boolean>('enabled', true)) {
    vscode.window.showWarningMessage(
      'MCP server is disabled. Enable it in settings: copilotOrchestrator.mcp.enabled'
    );
    return;
  }

  // Show prompt with options
  const choice = await vscode.window.showInformationMessage(
    'Start the Copilot Orchestrator MCP server for GitHub Copilot Chat?',
    'Start Server',
    'Open MCP List'
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
  } else if (choice === 'Open MCP List') {
    await vscode.commands.executeCommand('workbench.action.chat.listMcpServers');
  }
}
