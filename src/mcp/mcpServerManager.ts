/**
 * @fileoverview MCP (Model Context Protocol) server lifecycle management.
 * 
 * The MCP server provides an SSE-based API for AI agents to interact
 * with the orchestrator. This module manages the server process lifecycle.
 * 
 * @module mcp/mcpServerManager
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import { IMcpManager } from '../interfaces/IMcpManager';

/**
 * Status of the MCP server.
 */
export type McpStatus = 'running' | 'stopped' | 'error';

/**
 * Configuration for the MCP server.
 */
export interface McpConfig {
  /** Whether the MCP server is enabled */
  enabled: boolean;
  /** Host for the MCP server to listen on */
  host: string;
  /** Port for the MCP server to listen on */
  port: number;
  /** Host of the orchestrator HTTP API */
  orchestratorHost?: string;
  /** Port of the orchestrator HTTP API */
  orchestratorPort?: number;
  /** Path to the MCP server script */
  serverPath: string;
}

/**
 * MCP server lifecycle manager.
 * 
 * Manages the MCP HTTP server process which provides SSE (Server-Sent Events)
 * for AI agent communication.
 * 
 * @example
 * ```typescript
 * const manager = new McpServerManager(context, config);
 * if (config.enabled) {
 *   manager.start();
 * }
 * 
 * // On extension deactivation
 * manager.stop();
 * ```
 */
export class McpServerManager implements IMcpManager {
  /** VS Code extension context */
  private readonly context: vscode.ExtensionContext;
  /** Server configuration */
  private readonly config: McpConfig;
  /** Child process for the MCP server */
  private process: cp.ChildProcess | undefined;
  /** Current server status */
  private status: McpStatus = 'stopped';
  /** Whether registered with VS Code's MCP definition provider */
  private registeredWithVSCode = false;
  /** Status change listeners */
  private statusListeners: Set<(status: McpStatus) => void> = new Set();
  /** Status bar item for displaying server status */
  private statusBarItem: vscode.StatusBarItem | undefined;
  
  /**
   * Create a new MCP server manager.
   * 
   * @param context - VS Code extension context
   * @param config - Server configuration
   */
  constructor(context: vscode.ExtensionContext, config: McpConfig) {
    this.context = context;
    this.config = config;
    
    // Create status bar item
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left, 
      99
    );
    this.statusBarItem.text = 'MCP: stopped';
    this.statusBarItem.tooltip = 'Copilot Orchestrator MCP HTTP Server';
    this.statusBarItem.show();
    
    context.subscriptions.push(this.statusBarItem);
    context.subscriptions.push({ dispose: () => this.stop() });
  }
  
  /**
   * Start the MCP server.
   * No-op if already running.
   */
  start(): void {
    if (this.process) {
      console.log('MCP server already running');
      return;
    }
    
    if (!this.config.enabled) {
      console.log('MCP server disabled in settings');
      return;
    }
    
    try {
      const { host, port, orchestratorHost, orchestratorPort, serverPath } = this.config;
      
      // Use 'localhost' for connections to work with both IPv4 and IPv6
      const mcpHost = host === '127.0.0.1' || host === '::1' ? 'localhost' : host;
      const orchHost = orchestratorHost === '127.0.0.1' || orchestratorHost === '::1' 
        ? 'localhost' 
        : (orchestratorHost || 'localhost');
      const orchPort = orchestratorPort || 39218;
      
      console.log(`Starting MCP HTTP server: ${serverPath}`);
      console.log(`MCP will listen on: http://${mcpHost}:${port}`);
      console.log(`Target Orchestrator API: http://${orchHost}:${orchPort}`);
      
      this.process = cp.spawn('node', [serverPath], {
        env: {
          ...process.env,
          ORCH_HOST: orchHost,
          ORCH_PORT: String(orchPort),
          MCP_PORT: String(port)
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      // Handle stdout
      this.process.stdout?.on('data', (data) => {
        console.log(`[MCP] ${data.toString().trim()}`);
      });
      
      // Handle stderr
      this.process.stderr?.on('data', (data) => {
        console.log(`[MCP] ${data.toString().trim()}`);
      });
      
      // Handle successful spawn
      this.process.on('spawn', () => {
        console.log('MCP HTTP server spawned successfully');
        this.setStatus('running');
      });
      
      // Handle errors
      this.process.on('error', (err) => {
        console.error('MCP server error:', err);
        this.setStatus('error');
      });
      
      // Handle exit
      this.process.on('exit', (code, signal) => {
        console.log(`MCP server exited: code=${code}, signal=${signal}`);
        this.process = undefined;
        this.setStatus('stopped');
      });
      
    } catch (err) {
      console.error('Failed to start MCP server:', err);
      this.setStatus('error');
      vscode.window.showWarningMessage(
        'Failed to start MCP HTTP server. Check console for details.'
      );
    }
  }
  
  /**
   * Stop the MCP server.
   * Gracefully terminates the server process.
   */
  stop(): void {
    if (this.process) {
      console.log('Stopping MCP server...');
      this.process.kill('SIGTERM');
      this.process = undefined;
      this.setStatus('stopped');
    }
  }
  
  /**
   * Check if the MCP server is running.
   */
  isRunning(): boolean {
    return this.process !== undefined && this.status === 'running';
  }
  
  /**
   * Get the MCP server endpoint URL.
   */
  getEndpoint(): string {
    return `http://localhost:${this.config.port}`;
  }
  
  /**
   * Subscribe to status changes.
   * 
   * @param callback - Called when status changes
   * @returns Unsubscribe function
   */
  onStatusChange(callback: (status: McpStatus) => void): () => void {
    this.statusListeners.add(callback);
    return () => this.statusListeners.delete(callback);
  }
  
  /**
   * Get configuration for registering with GitHub Copilot.
   * Returns JSON configuration suitable for Copilot's MCP settings.
   */
  getCopilotConfig(): object {
    return {
      mcpServers: {
        'copilot-orchestrator': {
          command: 'node',
          args: [this.config.serverPath],
          env: {
            ORCH_HOST: this.config.host,
            ORCH_PORT: String(this.config.port)
          }
        }
      }
    };
  }
  
  /**
   * Set status and notify listeners.
   */
  private setStatus(status: McpStatus): void {
    this.status = status;
    this.updateStatusBar();
    
    // Notify listeners
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch (e) {
        console.error('Error in MCP status listener:', e);
      }
    }
  }
  
  /**
   * Set whether the MCP server is registered with VS Code's definition provider.
   * This updates the status bar to show the server is available even if the
   * HTTP server isn't running (VS Code uses stdio transport instead).
   */
  setRegisteredWithVSCode(registered: boolean): void {
    this.registeredWithVSCode = registered;
    this.updateStatusBar();
  }
  
  /**
   * Update the status bar based on current state.
   */
  private updateStatusBar(): void {
    if (!this.statusBarItem) return;
    
    if (this.status === 'running') {
      // HTTP server is running
      this.statusBarItem.text = `$(radio-tower) MCP: ${this.config.port}`;
      this.statusBarItem.tooltip = `MCP Server running on http://${this.config.host}:${this.config.port}`;
      this.statusBarItem.backgroundColor = undefined;
    } else if (this.registeredWithVSCode) {
      // Not running HTTP, but registered with VS Code (stdio transport)
      this.statusBarItem.text = '$(check) MCP: registered';
      this.statusBarItem.tooltip = 'Copilot Orchestrator MCP registered with VS Code (stdio transport)';
      this.statusBarItem.backgroundColor = undefined;
    } else if (this.status === 'error') {
      this.statusBarItem.text = '$(error) MCP: error';
      this.statusBarItem.tooltip = 'Copilot Orchestrator MCP server error';
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
      this.statusBarItem.text = '$(circle-slash) MCP: stopped';
      this.statusBarItem.tooltip = 'Copilot Orchestrator MCP server stopped';
      this.statusBarItem.backgroundColor = undefined;
    }
  }
}

/**
 * Create an MCP manager from VS Code configuration.
 * 
 * @param context - VS Code extension context
 * @returns Configured MCP server manager
 */
export function createMcpManager(context: vscode.ExtensionContext): McpServerManager {
  const mcpCfg = vscode.workspace.getConfiguration('copilotOrchestrator.mcp');
  const httpCfg = vscode.workspace.getConfiguration('copilotOrchestrator.http');
  
  const config: McpConfig = {
    enabled: mcpCfg.get<boolean>('enabled', true),
    host: mcpCfg.get<string>('host', 'localhost'),
    port: mcpCfg.get<number>('port', 39219),
    orchestratorHost: httpCfg.get<string>('host', 'localhost'),
    orchestratorPort: httpCfg.get<number>('port', 39218),
    serverPath: vscode.Uri.joinPath(
      context.extensionUri, 
      'server', 
      'mcp-server.js'
    ).fsPath
  };
  
  return new McpServerManager(context, config);
}
