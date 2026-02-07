/**
 * @fileoverview MCP (Model Context Protocol) server lifecycle management.
 * 
 * Uses stdio transport where VS Code manages the child process lifecycle.
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
 * MCP server manager for stdio transport.
 *
 * VS Code manages the child process lifecycle, so no health-check polling
 * is needed. This manager is a thin status tracker for the status bar.
 */
export class StdioMcpServerManager implements IMcpManager {
  readonly transport = 'stdio' as const;
  private status: McpStatus = 'stopped';
  private statusListeners: Set<(status: McpStatus) => void> = new Set();
  private statusBarItem: vscode.StatusBarItem | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      99,
    );
    this.statusBarItem.text = '$(circle-slash) MCP: stopped';
    this.statusBarItem.tooltip = 'Copilot Orchestrator MCP Server (stdio)';
    this.statusBarItem.show();

    context.subscriptions.push(this.statusBarItem);
    context.subscriptions.push({ dispose: () => { try { this.stop(); } catch { /* already stopped */ } } });
  }

  start(): void {
    log.info('MCP stdio server marked as connected');
    this.setStatus('connected');
  }

  stop(): void {
    log.info('MCP stdio server stopped');
    this.setStatus('stopped');
  }

  isRunning(): boolean {
    return this.status === 'connected' || this.status === 'available';
  }

  getEndpoint(): string {
    return 'stdio';
  }

  onStatusChange(callback: (status: McpStatus) => void): () => void {
    this.statusListeners.add(callback);
    return () => this.statusListeners.delete(callback);
  }

  private setStatus(status: McpStatus): void {
    this.status = status;
    this.updateStatusBar();
    for (const listener of this.statusListeners) {
      try { listener(status); } catch { /* ignore */ }
    }
  }

  private updateStatusBar(): void {
    if (!this.statusBarItem) { return; }
    if (this.status === 'connected') {
      this.statusBarItem.text = '$(check) MCP: stdio';
      this.statusBarItem.tooltip = 'Copilot Orchestrator MCP connected (stdio transport)';
      this.statusBarItem.backgroundColor = undefined;
    } else if (this.status === 'error') {
      this.statusBarItem.text = '$(error) MCP: error';
      this.statusBarItem.tooltip = 'Copilot Orchestrator MCP server error (stdio)';
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
      this.statusBarItem.text = '$(circle-slash) MCP: stopped';
      this.statusBarItem.tooltip = 'Copilot Orchestrator MCP server stopped';
      this.statusBarItem.backgroundColor = undefined;
    }
  }
}
