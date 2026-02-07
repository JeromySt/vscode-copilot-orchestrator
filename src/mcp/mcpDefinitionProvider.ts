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
 *
 * Mirrors the relevant subset of the extension's `copilotOrchestrator.mcp.*`
 * settings.
 */
export interface McpDefinitionProviderConfig {
  /** Hostname the HTTP/MCP server binds to (e.g. `"localhost"`). */
  host: string;
  /** TCP port the HTTP/MCP server listens on (default `39219`). */
  port: number;
  /** Absolute path to the workspace root, used for display purposes. */
  workspacePath?: string;
}

/**
 * Event emitter fired when the MCP server definition changes
 * (e.g. settings update, server start/stop).
 *
 * VS Code listens to this event to re-query
 * {@link vscode.McpServerDefinitionProvider.provideMcpServerDefinitions}.
 */
const serverChangedEmitter = new vscode.EventEmitter<void>();

/** Current provider configuration, updated on settings changes. */
let currentConfig: McpDefinitionProviderConfig | undefined;

/** Whether the MCP server feature is enabled in user settings. */
let isEnabled = true;

/**
 * Create and register the MCP Server Definition Provider with VS Code.
 *
 * This enables VS Code (1.99+) to automatically discover the Copilot
 * Orchestrator's MCP server and make it available to GitHub Copilot Chat
 * without manual configuration in `.vscode/mcp.json`.
 *
 * The provider uses the **HTTP transport** — the extension serves the MCP
 * endpoint directly at `http://<host>:<port>/mcp`.
 *
 * The registration also watches for `copilotOrchestrator.mcp.*` settings
 * changes and fires {@link serverChangedEmitter} to notify VS Code.
 *
 * @param context - VS Code extension context (for subscriptions & extension info).
 * @param config  - Initial MCP server configuration.
 * @returns A composite {@link vscode.Disposable} that unregisters the provider
 *          and stops watching settings.  Returns a no-op disposable if the
 *          VS Code API is not available.
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
