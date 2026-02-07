/**
 * @fileoverview MCP Server Definition Provider for automatic registration.
 * 
 * This module implements VS Code's McpServerDefinitionProvider interface
 * to automatically register the Copilot Orchestrator MCP server with
 * GitHub Copilot Chat. Supports both stdio and HTTP transports.
 * 
 * @module mcp/mcpDefinitionProvider
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { McpTransportKind } from '../interfaces/IMcpManager';

/**
 * Configuration for the MCP Definition Provider.
 */
export interface McpDefinitionProviderConfig {
  /** Transport to use: 'stdio' or 'http'. */
  transport: McpTransportKind;
  /** Hostname the HTTP/MCP server binds to (only used for HTTP). */
  host: string;
  /** TCP port the HTTP/MCP server listens on (only used for HTTP). */
  port: number;
  /** Absolute path to the workspace root. */
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
 * Supports both **stdio** and **HTTP** transports. When transport is
 * `'stdio'`, the provider returns a `McpStdioServerDefinition` that
 * points at the bundled `mcp-stdio-server.js` entry-point.  When
 * transport is `'http'`, it returns the existing HTTP definition.
 *
 * Falls back to HTTP if `McpStdioServerDefinition` is not available
 * (VS Code < 1.99).
 *
 * @param context - VS Code extension context.
 * @param config  - Initial MCP server configuration.
 * @returns A composite {@link vscode.Disposable}.
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

  const useStdio = config.transport === 'stdio';

  console.log('[MCP Provider] Registering MCP server definition provider...');
  console.log(`[MCP Provider] Transport: ${config.transport}`);
  if (!useStdio) {
    console.log(`[MCP Provider] HTTP endpoint: http://${config.host}:${config.port}/mcp`);
  }
  console.log(`[MCP Provider] Workspace: ${config.workspacePath}`);

  // Determine if stdio is available at runtime
  const stdioAvailable = useStdio && typeof (vscode as any).McpStdioServerDefinition === 'function';
  if (useStdio && !stdioAvailable) {
    console.warn('[MCP Provider] McpStdioServerDefinition not available; falling back to HTTP transport.');
  }

  const effectiveStdio = useStdio && stdioAvailable;

  // Create the provider
  const provider: vscode.McpServerDefinitionProvider<vscode.McpServerDefinition> = {
    onDidChangeMcpServerDefinitions: serverChangedEmitter.event,
    
    provideMcpServerDefinitions(
      _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.McpServerDefinition[]> {
      console.log(`[MCP Provider] provideMcpServerDefinitions called, enabled=${isEnabled}`);
      
      if (!isEnabled || !currentConfig) {
        console.log('[MCP Provider] Returning empty list (disabled or no config)');
        return [];
      }

      if (effectiveStdio) {
        const extensionPath = context.extensionPath;
        const serverScript = path.join(extensionPath, 'out', 'mcp', 'stdio', 'server.js');
        const workspacePath = currentConfig.workspacePath || '';
        const storagePath = workspacePath
          ? path.join(workspacePath, '.orchestrator', 'plans')
          : path.join(context.globalStorageUri.fsPath, 'plans');

        const server = new (vscode as any).McpStdioServerDefinition({
          label: 'Copilot Orchestrator',
          command: 'node',
          args: [serverScript],
          cwd: workspacePath ? vscode.Uri.file(workspacePath) : undefined,
          env: {
            ORCHESTRATOR_WORKSPACE: workspacePath,
            ORCHESTRATOR_STORAGE: storagePath,
          },
          version: context.extension.packageJSON.version,
        });

        console.log(`[MCP Provider] Returning stdio server: ${server.label}`);
        return [server];
      }

      // HTTP fallback
      const mcpUrl = vscode.Uri.parse(`http://${currentConfig.host}:${currentConfig.port}/mcp`);
      const server = new vscode.McpHttpServerDefinition(
        'Copilot Orchestrator',
        mcpUrl,
        context.extension.packageJSON.version
      );
      
      console.log(`[MCP Provider] Returning HTTP server: ${server.label}, url: ${mcpUrl.toString()}`);
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
        
        if (currentConfig) {
          currentConfig.host = mcpConfig.get<string>('host', 'localhost');
          currentConfig.port = mcpConfig.get<number>('port', 39219);
        }
        
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
