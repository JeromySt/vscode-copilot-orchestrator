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
Endpoint: http://${host}:${port}
If your Agent requires stdio, run: node server/mcp-server.js`;

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
 * 
 * @param host - MCP server host address
 * @param port - MCP server port number
 */
async function showRegistrationInstructions(host: string, port: number): Promise<void> {
  const instructions = `
# MCP Server Registration

To use Copilot Orchestrator with GitHub Copilot Chat, add this to your VS Code settings:

\`\`\`json
{
  "github.copilot.chat.mcp.servers": {
    "orchestrator": {
      "type": "http",
      "url": "http://${host}:${port}/mcp"
    }
  }
}
\`\`\`

Or for stdio mode (external agents):
\`\`\`bash
node server/mcp-server.js
\`\`\`

The server provides these tools:
- **orchestrator.job.create** - Create a new background job
- **orchestrator.job.status** - Get job status and results
- **orchestrator.plan.create** - Create multi-step execution plans
- **orchestrator.plan.status** - Monitor plan execution
- **orchestrator.plan.cancel** - Cancel running plans
`;

  const doc = await vscode.workspace.openTextDocument({
    content: instructions,
    language: 'markdown'
  });
  await vscode.window.showTextDocument(doc, { preview: true });

  // Copy settings snippet to clipboard
  const settingsSnippet = JSON.stringify({
    "github.copilot.chat.mcp.servers": {
      "orchestrator": {
        "type": "http",
        "url": `http://${host}:${port}/mcp`
      }
    }
  }, null, 2);

  await vscode.env.clipboard.writeText(settingsSnippet);
  vscode.window.showInformationMessage(
    'MCP server settings copied to clipboard. Paste into your VS Code settings.json'
  );
}
