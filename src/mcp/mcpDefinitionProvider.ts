/**
 * @fileoverview MCP Server Definition Provider for automatic registration.
 * 
 * This module implements VS Code's McpServerDefinitionProvider interface
 * to automatically register the Copilot Orchestrator MCP server with
 * GitHub Copilot Chat using stdio transport.
 * 
 * @module mcp/mcpDefinitionProvider
 */

import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Event emitter fired when the MCP server definition changes
 * (e.g. settings update, server start/stop).
 *
 * VS Code listens to this event to re-query
 * {@link vscode.McpServerDefinitionProvider.provideMcpServerDefinitions}.
 */
const serverChangedEmitter = new vscode.EventEmitter<void>();

/** Current workspace path. */
let currentWorkspacePath: string | undefined;

/** Whether the MCP server feature is enabled in user settings. */
let isEnabled = true;

/**
 * Create and register the MCP Server Definition Provider with VS Code.
 *
 * Uses stdio transport where VS Code spawns a child process that
 * communicates via stdin/stdout using the MCP protocol.
 *
 * @param context - VS Code extension context.
 * @param workspacePath - Absolute path to the workspace root.
 * @returns A composite {@link vscode.Disposable}.
 */
export function registerMcpDefinitionProvider(
  context: vscode.ExtensionContext,
  workspacePath: string
): vscode.Disposable {
  currentWorkspacePath = workspacePath;
  
  // Check if MCP is enabled
  const mcpConfig = vscode.workspace.getConfiguration('copilotOrchestrator.mcp');
  isEnabled = mcpConfig.get<boolean>('enabled', true);

  // Check if the API is available
  if (!vscode.lm || typeof vscode.lm.registerMcpServerDefinitionProvider !== 'function') {
    console.warn('[MCP Provider] vscode.lm.registerMcpServerDefinitionProvider is not available. MCP auto-registration requires VS Code 1.99+ with GitHub Copilot.');
    return { dispose: () => {} };
  }

  // Check if stdio is available at runtime
  const stdioAvailable = typeof (vscode as any).McpStdioServerDefinition === 'function';
  if (!stdioAvailable) {
    console.warn('[MCP Provider] McpStdioServerDefinition not available. Requires VS Code 1.99+.');
    return { dispose: () => {} };
  }

  console.log('[MCP Provider] Registering MCP server definition provider (stdio)...');
  console.log(`[MCP Provider] Workspace: ${workspacePath}`);

  // Create the provider
  const provider: vscode.McpServerDefinitionProvider<vscode.McpServerDefinition> = {
    onDidChangeMcpServerDefinitions: serverChangedEmitter.event,
    
    provideMcpServerDefinitions(
      _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.McpServerDefinition[]> {
      console.log(`[MCP Provider] provideMcpServerDefinitions called, enabled=${isEnabled}`);
      
      if (!isEnabled) {
        console.log('[MCP Provider] Returning empty list (disabled)');
        return [];
      }

      const extensionPath = context.extensionPath;
      const serverScript = path.join(extensionPath, 'out', 'mcp', 'stdio', 'server.js');
      const storagePath = currentWorkspacePath
        ? path.join(currentWorkspacePath, '.orchestrator', 'plans')
        : path.join(context.globalStorageUri.fsPath, 'plans');

      // McpStdioServerDefinition constructor: (label, command, args?, options?)
      const server = new (vscode as any).McpStdioServerDefinition(
        'Copilot Orchestrator',  // label
        'node',                  // command
        [serverScript],          // args
        {
          cwd: currentWorkspacePath ? vscode.Uri.file(currentWorkspacePath) : undefined,
          env: {
            ORCHESTRATOR_WORKSPACE: currentWorkspacePath || '',
            ORCHESTRATOR_STORAGE: storagePath,
          },
          version: context.extension.packageJSON.version,
        }
      );

      console.log(`[MCP Provider] Returning stdio server: ${server.label}`);
      return [server];
    },
    
    resolveMcpServerDefinition(
      server: vscode.McpServerDefinition,
      _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.McpServerDefinition> {
      console.log(`[MCP Provider] Resolving server: ${(server as any).label}`);
      return server;
    }
  };
  
  // Register with VS Code
  try {
    const registration = vscode.lm.registerMcpServerDefinitionProvider(
      'copilot-orchestrator.mcp-server',
      provider
    );
    console.log('[MCP Provider] Successfully registered with VS Code');
    
    // Listen for configuration changes
    const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('copilotOrchestrator.mcp')) {
        const mcpConfig = vscode.workspace.getConfiguration('copilotOrchestrator.mcp');
        isEnabled = mcpConfig.get<boolean>('enabled', true);
        
        serverChangedEmitter.fire();
        console.log('[MCP Provider] Configuration changed, notifying VS Code');
      }
    });
    
    console.log('[MCP Provider] Registered Copilot Orchestrator MCP server with VS Code');
    
    return vscode.Disposable.from(registration, configWatcher, serverChangedEmitter);
  } catch (error) {
    console.error('[MCP Provider] Failed to register:', error);
    return { dispose: () => {} };
  }
}

/**
 * Notify VS Code that the MCP server availability has changed.
 *
 * Call this whenever the server starts, stops, or changes configuration
 * so that VS Code re-queries the provider for updated definitions.
 */
export function notifyServerChanged(): void {
  serverChangedEmitter.fire();
}

/**
 * Programmatically update the enabled state of the MCP server definition.
 *
 * Fires a change notification only if the state actually changes, causing
 * VS Code to re-query the provider.
 *
 * @param enabled - `true` to advertise the server, `false` to hide it.
 */
export function setMcpServerEnabled(enabled: boolean): void {
  if (isEnabled !== enabled) {
    isEnabled = enabled;
    serverChangedEmitter.fire();
  }
}
