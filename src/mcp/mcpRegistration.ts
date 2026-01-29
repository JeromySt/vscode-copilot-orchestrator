/**
 * @fileoverview MCP server registration prompts for GitHub Copilot.
 * 
 * Handles the user flow for registering the MCP server with
 * GitHub Copilot Chat for agent-based job creation.
 * 
 * @module mcp/mcpRegistration
 */

import * as vscode from 'vscode';

/**
 * State key for tracking whether user has been prompted.
 */
const PROMPTED_STATE_KEY = 'mcpServerPrompted';

/**
 * Prompt user to register the MCP server with GitHub Copilot.
 * 
 * Shows a one-time prompt with options to:
 * - Add to Copilot (copies config to clipboard)
 * - Copy instructions
 * - Dismiss temporarily
 * - Dismiss permanently
 * 
 * @param context - VS Code extension context
 */
export async function promptMcpServerRegistration(
  context: vscode.ExtensionContext
): Promise<void> {
  // Check if already prompted
  const hasPrompted = context.globalState.get<boolean>(PROMPTED_STATE_KEY, false);
  if (hasPrompted) return;
  
  // Check if MCP is enabled
  const mcpConfig = vscode.workspace.getConfiguration('copilotOrchestrator.mcp');
  if (!mcpConfig.get<boolean>('enabled', true)) return;
  
  const host = mcpConfig.get<string>('host', 'localhost');
  const port = mcpConfig.get<number>('port', 39219);
  
  const choice = await vscode.window.showInformationMessage(
    'Copilot Orchestrator MCP server is running. Would you like to add it to GitHub Copilot Chat for agent-based job creation?',
    'Add to Copilot',
    'Copy Instructions',
    'Not Now',
    "Don't Show Again"
  );
  
  if (choice === 'Add to Copilot') {
    await handleAddToCopilot(context, host, port);
    await context.globalState.update(PROMPTED_STATE_KEY, true);
  } else if (choice === 'Copy Instructions') {
    await handleCopyInstructions(context, host, port);
    await context.globalState.update(PROMPTED_STATE_KEY, true);
  } else if (choice === "Don't Show Again") {
    await context.globalState.update(PROMPTED_STATE_KEY, true);
  }
  // 'Not Now' - don't update state, will prompt again next time
}

/**
 * Handle "Add to Copilot" action.
 * Copies MCP configuration JSON to clipboard.
 */
async function handleAddToCopilot(
  context: vscode.ExtensionContext,
  host: string,
  port: number
): Promise<void> {
  const config = {
    mcpServers: {
      'copilot-orchestrator': {
        type: 'http',
        url: `http://${host}:${port}/mcp`
      }
    }
  };
  
  const configJson = JSON.stringify(config, null, 2);
  await vscode.env.clipboard.writeText(configJson);
  
  const openSettings = await vscode.window.showInformationMessage(
    'MCP server configuration copied to clipboard! Add this to your GitHub Copilot settings (usually in ~/.copilot/config.json or VS Code settings).',
    'Open Settings',
    'Show Instructions'
  );
  
  if (openSettings === 'Open Settings') {
    await vscode.commands.executeCommand(
      'workbench.action.openSettings', 
      'github.copilot'
    );
  } else if (openSettings === 'Show Instructions') {
    const docPath = vscode.Uri.joinPath(
      context.extensionUri, 
      'docs', 
      'COPILOT_INTEGRATION.md'
    );
    
    try {
      const doc = await vscode.workspace.openTextDocument(docPath);
      await vscode.window.showTextDocument(doc);
    } catch {
      // Doc may not exist, show inline instructions
      showInlineInstructions(context, host, port);
    }
  }
}

/**
 * Handle "Copy Instructions" action.
 * Copies detailed setup instructions to clipboard.
 */
async function handleCopyInstructions(
  context: vscode.ExtensionContext,
  host: string,
  port: number
): Promise<void> {
  const instructions = `# Add Copilot Orchestrator to GitHub Copilot Chat

1. Locate your Copilot configuration file:
   - Windows: %USERPROFILE%\\.copilot\\config.json
   - Mac/Linux: ~/.copilot/config.json
   - Or in VS Code settings (search for "github.copilot.mcpServers")

2. Add this configuration:

{
  "mcpServers": {
    "copilot-orchestrator": {
      "type": "http",
      "url": "http://${host}:${port}/mcp"
    }
  }
}

3. Reload VS Code or restart Copilot Chat

4. Test by asking: "Use the Copilot Orchestrator to create a job for [task]"

HTTP API is also available at: http://${host}:${port}
`;
  
  await vscode.env.clipboard.writeText(instructions);
  vscode.window.showInformationMessage('Instructions copied to clipboard!');
}

/**
 * Show instructions in a webview or output channel.
 */
function showInlineInstructions(
  context: vscode.ExtensionContext,
  host: string,
  port: number
): void {
  const outputChannel = vscode.window.createOutputChannel('Copilot Orchestrator Setup');
  outputChannel.appendLine('=== Copilot Orchestrator MCP Setup ===\n');
  outputChannel.appendLine('Add this to your GitHub Copilot configuration:\n');
  outputChannel.appendLine(JSON.stringify({
    mcpServers: {
      'copilot-orchestrator': {
        type: 'http',
        url: `http://${host}:${port}/mcp`
      }
    }
  }, null, 2));
  outputChannel.appendLine('\n\nHTTP API available at: http://' + host + ':' + port);
  outputChannel.appendLine('MCP endpoint: http://' + host + ':' + port + '/mcp');
  outputChannel.show();
}

/**
 * Reset the registration prompt state.
 * Useful for testing or if user wants to see the prompt again.
 */
export async function resetMcpRegistrationPrompt(
  context: vscode.ExtensionContext
): Promise<void> {
  await context.globalState.update(PROMPTED_STATE_KEY, false);
}
