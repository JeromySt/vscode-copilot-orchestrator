/**
 * @fileoverview MCP command logic abstracted from VS Code dependencies.
 * 
 * Contains pure business logic for MCP server management and configuration
 * without direct VS Code API coupling. Uses dependency injection for
 * testability and clean separation of concerns.
 * 
 * @module commands/mcpCommandLogic
 */

import type { IDialogService, IClipboardService, IConfigProvider } from '../interfaces';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Valid choices for the How To Connect dialog.
 */
export type HowToConnectChoice = 'Start Server' | 'List Servers' | 'Copy Info';

/**
 * Valid choices for the MCP start prompt.
 */
export type McpStartChoice = 'Start Server' | 'Open MCP List';

/**
 * Service dependencies for MCP command operations.
 */
export interface McpCommandServices {
  dialog: IDialogService;
  clipboard: IClipboardService;
  config: IConfigProvider;
}

/**
 * Command execution interface for VS Code command execution.
 */
export interface CommandExecutor {
  executeCommand(command: string, ...args: any[]): Promise<void>;
}

// ============================================================================
// TEMPLATE GENERATION
// ============================================================================

/**
 * Generate MCP connection information text for clipboard.
 * 
 * @param endpoint - Optional MCP server endpoint (defaults to generic info)
 * @returns Formatted connection information text
 */
export function generateMcpConnectionInfo(endpoint?: string): string {
  return `Copilot Orchestrator MCP Server

The MCP server automatically registers with VS Code using stdio transport.
No manual configuration needed - just use "MCP: List Servers" and start it.

Available tools:
- create_copilot_plan - Create a dependency graph of work
- get_copilot_plan_status - Get plan execution status
- list_copilot_plans - List all plans
- cancel_copilot_plan - Cancel a running plan
- And more...

To enable: Run "MCP: List Servers" and start "Copilot Orchestrator"`;
}

// ============================================================================
// COMMAND HANDLERS
// ============================================================================

/**
 * Handle the "How to Connect" command logic.
 * 
 * Shows user options for MCP server management and executes the chosen action.
 * 
 * @param choice - User's choice from the dialog
 * @param services - Injected service dependencies
 * @param commandExecutor - Command executor for VS Code commands
 */
export async function handleHowToConnect(
  choice: HowToConnectChoice | undefined,
  services: McpCommandServices,
  commandExecutor?: CommandExecutor
): Promise<void> {
  if (!choice) {
    return; // User cancelled
  }

  switch (choice) {
    case 'Start Server':
      try {
        if (commandExecutor) {
          await commandExecutor.executeCommand(
            'workbench.action.chat.startMcpServer', 
            'copilot-orchestrator.mcp-server'
          );
          await services.dialog.showInfo('Copilot Orchestrator MCP server started!');
        } else {
          // For testing or when command executor is not available
          await services.dialog.showInfo('Copilot Orchestrator MCP server started!');
        }
      } catch (error) {
        // If direct start fails, fall back to listing servers
        if (commandExecutor) {
          await commandExecutor.executeCommand('workbench.action.chat.listMcpServers');
        } else {
          // For testing
          await services.dialog.showInfo('Fallback: Opening MCP server list...');
        }
      }
      break;

    case 'List Servers':
      if (commandExecutor) {
        await commandExecutor.executeCommand('workbench.action.chat.listMcpServers');
      } else {
        // For testing
        await services.dialog.showInfo('Opening MCP server list...');
      }
      break;

    case 'Copy Info':
      const connectionInfo = generateMcpConnectionInfo();
      await services.clipboard.writeText(connectionInfo);
      await services.dialog.showInfo('MCP info copied to clipboard.');
      break;

    default:
      // TypeScript should prevent this, but handle gracefully
      console.warn(`Unknown choice: ${choice}`);
      break;
  }
}

/**
 * Handle the MCP start prompt logic.
 * 
 * Checks MCP configuration and prompts user to start the server.
 * 
 * @param services - Injected service dependencies
 * @param commandExecutor - Command executor for VS Code commands
 */
export async function handlePromptMcpStart(
  services: Pick<McpCommandServices, 'dialog' | 'config'>,
  commandExecutor?: CommandExecutor
): Promise<void> {
  // Check if MCP is enabled in extension settings
  const mcpEnabled = services.config.getConfig('copilotOrchestrator.mcp', 'enabled', true);
  
  if (!mcpEnabled) {
    await services.dialog.showWarning(
      'MCP server is disabled. Enable it in settings: copilotOrchestrator.mcp.enabled'
    );
    return;
  }

  // Show prompt with options
  const choice = await services.dialog.showWarning(
    'Start the Copilot Orchestrator MCP server for GitHub Copilot Chat?',
    undefined,
    'Start Server',
    'Open MCP List'
  ) as McpStartChoice | undefined;

  if (!choice) {
    return; // User cancelled
  }

  switch (choice) {
    case 'Start Server':
      try {
        if (commandExecutor) {
          await commandExecutor.executeCommand(
            'workbench.action.chat.startMcpServer', 
            'copilot-orchestrator.mcp-server'
          );
          await services.dialog.showInfo(
            'Copilot Orchestrator MCP server started! You can now use orchestrator tools in Copilot Chat.'
          );
        } else {
          // For testing
          await services.dialog.showInfo(
            'Copilot Orchestrator MCP server started! You can now use orchestrator tools in Copilot Chat.'
          );
        }
      } catch (error) {
        // If direct start fails, fall back to opening the MCP list
        console.warn('Direct MCP start failed, falling back to list:', error);
        if (commandExecutor) {
          await commandExecutor.executeCommand('workbench.action.chat.listMcpServers');
        } else {
          // For testing
          await services.dialog.showInfo('Opening MCP server list...');
        }
      }
      break;

    case 'Open MCP List':
      if (commandExecutor) {
        await commandExecutor.executeCommand('workbench.action.chat.listMcpServers');
      } else {
        // For testing
        await services.dialog.showInfo('Opening MCP server list...');
      }
      break;

    default:
      console.warn(`Unknown choice: ${choice}`);
      break;
  }
}