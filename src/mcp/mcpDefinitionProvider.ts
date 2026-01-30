/**
 * @fileoverview MCP Server Definition Provider for automatic registration.
 * 
 * This module implements VS Code's McpServerDefinitionProvider interface
 * to automatically register the Copilot Orchestrator MCP server with
 * GitHub Copilot Chat. Users no longer need to manually configure
 * .vscode/mcp.json or copy configurations.
 * 
 * @module mcp/mcpDefinitionProvider
 */

import * as vscode from 'vscode';

/**
 * Configuration for the MCP Definition Provider.
 */
export interface McpDefinitionProviderConfig {
  /** Host the MCP server runs on */
  host: string;
  /** Port the MCP server listens on */
  port: number;
  /** Workspace path for the MCP server */
  workspacePath?: string;
}

/**
 * Event emitter for server definition changes.
 */
const serverChangedEmitter = new vscode.EventEmitter<void>();

/**
 * Current configuration - updated when settings change.
 */
let currentConfig: McpDefinitionProviderConfig | undefined;

/**
 * Flag indicating if the MCP server is enabled.
 */
let isEnabled = true;

/**
 * Creates and registers the MCP Server Definition Provider.
 * 
 * This enables VS Code to automatically discover and use the
 * Copilot Orchestrator MCP server without manual configuration.
 * 
 * @param context - VS Code extension context
 * @param config - Initial MCP server configuration
 * @returns Disposable to unregister the provider
 */
export function registerMcpDefinitionProvider(
  context: vscode.ExtensionContext,
  config: McpDefinitionProviderConfig
): vscode.Disposable {
  currentConfig = config;
  
  // Check if MCP is enabled
  const mcpConfig = vscode.workspace.getConfiguration('copilotOrchestrator.mcp');
  isEnabled = mcpConfig.get<boolean>('enabled', true);

  // Check if the API is available
  if (!vscode.lm || typeof vscode.lm.registerMcpServerDefinitionProvider !== 'function') {
    console.warn('[MCP Provider] vscode.lm.registerMcpServerDefinitionProvider is not available. MCP auto-registration requires VS Code 1.99+ with GitHub Copilot.');
    return { dispose: () => {} };
  }

  console.log('[MCP Provider] Registering MCP server definition provider...');
  console.log(`[MCP Provider] HTTP endpoint: http://${config.host}:${config.port}/mcp`);
  console.log(`[MCP Provider] Workspace: ${config.workspacePath}`);
  
  // Create the provider - use HTTP transport
  const provider: vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition> = {
    onDidChangeMcpServerDefinitions: serverChangedEmitter.event,
    
    provideMcpServerDefinitions(
      _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.McpHttpServerDefinition[]> {
      console.log(`[MCP Provider] provideMcpServerDefinitions called, enabled=${isEnabled}`);
      
      if (!isEnabled || !currentConfig) {
        console.log('[MCP Provider] Returning empty list (disabled or no config)');
        return [];
      }
      
      // Use HTTP transport - extension serves the MCP endpoint directly
      const mcpUrl = vscode.Uri.parse(`http://${currentConfig.host}:${currentConfig.port}/mcp`);
      const server = new vscode.McpHttpServerDefinition(
        'Copilot Orchestrator',                    // label
        mcpUrl,                                     // url
        context.extension.packageJSON.version       // version
      );
      
      console.log(`[MCP Provider] Returning server: ${server.label}, url: ${mcpUrl.toString()}`);
      return [server];
    },
    
    resolveMcpServerDefinition(
      server: vscode.McpHttpServerDefinition,
      _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.McpHttpServerDefinition> {
      // No additional resolution needed - server config is complete
      console.log(`[MCP Provider] Resolving server: ${server.label}`);
      return server;
    }
  };
  
  // Register with VS Code
  // The id must match the one in package.json contributes.mcpServerDefinitionProviders
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
        
        // Update config
        if (currentConfig) {
          currentConfig.host = mcpConfig.get<string>('host', 'localhost');
          currentConfig.port = mcpConfig.get<number>('port', 39219);
        }
        
        // Notify VS Code that servers changed
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
 * Notifies VS Code that the MCP server availability has changed.
 * Call this when the server starts or stops.
 */
export function notifyServerChanged(): void {
  serverChangedEmitter.fire();
}

/**
 * Updates the enabled state of the MCP server.
 * @param enabled - Whether the server should be available
 */
export function setMcpServerEnabled(enabled: boolean): void {
  if (isEnabled !== enabled) {
    isEnabled = enabled;
    serverChangedEmitter.fire();
  }
}
