/**
 * @fileoverview MCP (Model Context Protocol) server lifecycle management.
 * 
 * The MCP server runs as part of the extension's HTTP server on /mcp endpoint.
 * This module manages the status bar display and configuration.
 * 
 * @module mcp/mcpServerManager
 */

import * as vscode from 'vscode';
import { IMcpManager } from '../interfaces/IMcpManager';
import { Logger, ComponentLogger } from '../core/logger';

/** MCP component logger */
const log: ComponentLogger = Logger.for('mcp');

/**
 * Status of the MCP server.
 */
export type McpStatus = 'connected' | 'available' | 'stopped' | 'error';

/**
 * Configuration for the MCP server.
 */
export interface McpConfig {
  /** Whether the MCP server is enabled */
  enabled: boolean;
  /** Host for the HTTP server */
  host: string;
  /** Port for the HTTP server */
  port: number;
  /** Path to the MCP server script (deprecated, kept for compatibility) */
  serverPath: string;
  /** Workspace path for the MCP server */
  workspacePath?: string;
}

/**
 * MCP server lifecycle manager.
 * 
 * The MCP server runs as part of the extension's HTTP server on /mcp endpoint.
 * This manager handles status display, configuration, and connectivity checks.
 * 
 * @example
 * ```typescript
 * const manager = new McpServerManager(context, config);
 * manager.start(); // Starts health checks
 * ```
 */
export class McpServerManager implements IMcpManager {
  /** VS Code extension context */
  private readonly context: vscode.ExtensionContext;
  /** Server configuration */
  private readonly config: McpConfig;
  /** Current server status */
  private status: McpStatus = 'stopped';
  /** Whether registered with VS Code's MCP definition provider */
  private registeredWithVSCode = false;
  /** Status change listeners */
  private statusListeners: Set<(status: McpStatus) => void> = new Set();
  /** Status bar item for displaying server status */
  private statusBarItem: vscode.StatusBarItem | undefined;
  /** Health check interval */
  private healthCheckInterval: NodeJS.Timeout | undefined;
  /** Number of consecutive failures */
  private consecutiveFailures = 0;
  
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
    this.statusBarItem.tooltip = 'Copilot Orchestrator MCP Server (HTTP)';
    this.statusBarItem.show();
    
    context.subscriptions.push(this.statusBarItem);
    context.subscriptions.push({ dispose: () => this.stop() });
  }
  
  /**
   * Mark the MCP server as available and start health checks.
   * The MCP endpoint is served via the HTTP server.
   */
  start(): void {
    if (!this.config.enabled) {
      log.info('MCP server disabled in settings');
      return;
    }
    
    log.info('MCP server starting', { 
      endpoint: `http://${this.config.host}:${this.config.port}/mcp`,
      workspace: this.config.workspacePath || 'default'
    });
    
    this.setStatus('available');
    
    // Start periodic health checks
    this.startHealthChecks();
  }
  
  /**
   * Stop the MCP server and health checks.
   */
  stop(): void {
    log.info('MCP server stopping');
    this.stopHealthChecks();
    this.setStatus('stopped');
  }
  
  /**
   * Start periodic health checks to verify MCP endpoint connectivity.
   */
  private startHealthChecks(): void {
    log.debug('Starting health checks');
    // Initial check after a short delay (let server start)
    setTimeout(() => this.checkHealth(), 1000);
    
    // Periodic checks every 10 seconds
    this.healthCheckInterval = setInterval(() => this.checkHealth(), 10000);
  }
  
  /**
   * Stop health checks.
   */
  private stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      log.debug('Stopping health checks');
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }
  }
  
  /**
   * Check MCP endpoint health by sending a tools/list request.
   */
  private async checkHealth(): Promise<void> {
    const url = `http://${this.config.host}:${this.config.port}/mcp`;
    log.debug('Health check starting', { url });
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'health-check',
          method: 'tools/list'
        })
      });
      
      log.debug('Health check response', { status: response.status, ok: response.ok });
      
      if (response.ok) {
        const data = await response.json() as any;
        if (data.result && data.result.tools) {
          this.consecutiveFailures = 0;
          if (this.status !== 'connected') {
            log.info('Health check passed - connected', { toolCount: data.result.tools.length });
            this.setStatus('connected');
          } else {
            log.debug('Health check passed', { toolCount: data.result.tools.length });
          }
          return;
        } else {
          log.debug('Health check invalid response', { data });
        }
      }
      
      // Response not OK or invalid data
      this.handleHealthCheckFailure(`HTTP ${response.status}`);
    } catch (error: any) {
      log.debug('Health check error', { error: error.message });
      this.handleHealthCheckFailure(error.message || 'Connection failed');
    }
  }
  
  /**
   * Handle a health check failure.
   */
  private handleHealthCheckFailure(reason: string): void {
    this.consecutiveFailures++;
    log.debug('Health check failure', { reason, consecutiveFailures: this.consecutiveFailures });
    
    if (this.consecutiveFailures >= 3 && this.status !== 'error') {
      log.warn('Health check failed repeatedly', { reason, failures: this.consecutiveFailures });
      this.setStatus('error');
    } else if (this.consecutiveFailures < 3 && this.status === 'connected') {
      // Brief failure, mark as available (trying to reconnect)
      log.debug('Brief health check failure, retrying');
      this.setStatus('available');
    }
  }
  
  /**
   * Check if the MCP server is available.
   */
  isRunning(): boolean {
    return this.status === 'available' || this.status === 'connected';
  }
  
  /**
   * Get the MCP server endpoint URL.
   */
  getEndpoint(): string {
    return `http://${this.config.host}:${this.config.port}/mcp`;
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
          type: 'http',
          url: `http://${this.config.host}:${this.config.port}/mcp`
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
   * This is informational - actual connectivity is determined by health checks.
   */
  setRegisteredWithVSCode(registered: boolean): void {
    this.registeredWithVSCode = registered;
    console.log(`[MCP] Registered with VS Code: ${registered}`);
  }
  
  /**
   * Update the status bar based on current state.
   */
  private updateStatusBar(): void {
    if (!this.statusBarItem) return;
    
    const endpoint = `http://${this.config.host}:${this.config.port}/mcp`;
    
    if (this.status === 'connected') {
      // Connected and verified working
      this.statusBarItem.text = '$(check) MCP: connected';
      this.statusBarItem.tooltip = `Copilot Orchestrator MCP connected at ${endpoint}`;
      this.statusBarItem.backgroundColor = undefined;
    } else if (this.status === 'available') {
      // Server started, checking connectivity
      this.statusBarItem.text = '$(radio-tower) MCP: connecting...';
      this.statusBarItem.tooltip = `Copilot Orchestrator MCP server at ${endpoint}`;
      this.statusBarItem.backgroundColor = undefined;
    } else if (this.status === 'error') {
      this.statusBarItem.text = '$(error) MCP: error';
      this.statusBarItem.tooltip = `Copilot Orchestrator MCP server error - cannot reach ${endpoint}`;
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
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  
  const config: McpConfig = {
    enabled: mcpCfg.get<boolean>('enabled', true),
    host: mcpCfg.get<string>('host', 'localhost'),
    port: mcpCfg.get<number>('port', 39219),
    serverPath: vscode.Uri.joinPath(
      context.extensionUri, 
      'server', 
      'mcp-server.js'
    ).fsPath,
    workspacePath
  };
  
  return new McpServerManager(context, config);
}
