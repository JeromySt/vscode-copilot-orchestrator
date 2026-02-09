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

/** Current IPC server path (named pipe or Unix socket). */
let currentIpcPath: string | undefined;

/** Auth nonce for the IPC connection. */
let currentAuthNonce: string | undefined;

/** Whether the MCP server feature is enabled in user settings. */
let isEnabled = true;

/**
 * Create and register the MCP Server Definition Provider with VS Code.
 *
 * Uses stdio transport where VS Code spawns a child process that
 * communicates via stdin/stdout using the MCP protocol.
 * The stdio server connects back to the extension via IPC.
 *
 * @param context - VS Code extension context.
 * @param workspacePath - Absolute path to the workspace root.
 * @param ipcPath - Path to the IPC server (named pipe or Unix socket).
 * @param authNonce - Auth nonce for the IPC connection (passed via env, not command line).
 * @returns A composite {@link vscode.Disposable}.
 */
export function registerMcpDefinitionProvider(
  context: vscode.ExtensionContext,
  workspacePath: string,
  ipcPath: string,
  authNonce: string
): vscode.Disposable {
  currentWorkspacePath = workspacePath;
  currentIpcPath = ipcPath;
  currentAuthNonce = authNonce;
  
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
      console.log(`[MCP Provider] provideMcpServerDefinitions called, enabled=${isEnabled}, workspace=${currentWorkspacePath || '<none>'}`);
      
      if (!isEnabled) {
        console.log('[MCP Provider] Returning empty list (disabled)');
        return [];
      }

      // Require a workspace to be open - plans are workspace-relative
      if (!currentWorkspacePath) {
        console.log('[MCP Provider] Returning empty list (no workspace open)');
        return [];
      }

      // Require IPC path for the stdio server to connect back
      if (!currentIpcPath) {
        console.log('[MCP Provider] Returning empty list (no IPC path)');
        return [];
      }

      const extensionPath = context.extensionPath;
      const serverScript = path.join(extensionPath, 'dist', 'mcp-stdio-server.js');

      // The stdio server connects back to the extension via IPC
      // All config passed via environment variables to keep server "shape" stable
      // McpStdioServerDefinition constructor: (label, command, args?, env?, version?)
      // Note: cwd is a property that can be set after construction
      const server = new (vscode as any).McpStdioServerDefinition(
        'Copilot Orchestrator',  // label
        'node',                  // command
        [serverScript],          // args - no variable args, keeps shape stable
        {
          MCP_IPC_PATH: currentIpcPath,        // IPC connection path
          MCP_AUTH_NONCE: currentAuthNonce,    // Security: auth nonce for IPC
        },
        context.extension.packageJSON.version  // version
      );
      // Set cwd separately (it's a property, not a constructor param)
      server.cwd = vscode.Uri.file(currentWorkspacePath);

      console.log(`[MCP Provider] Returning stdio server: ${server.label}, ipc: ${currentIpcPath}`);
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
