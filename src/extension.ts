/**
 * @fileoverview VS Code Copilot Orchestrator Extension - Main Entry Point
 * 
 * This file is the composition root for the extension. It orchestrates
 * the initialization of all components using the Plan-based system.
 * 
 * Everything is a Plan - even a single job.
 * 
 * @module extension
 */

import * as vscode from 'vscode';
import {
  loadConfiguration,
  initializePlanRunner,
  initializeHttpServer,
  initializeMcpServer,
  initializePlansView,
  registerPlanCommands,
} from './core/planInitialization';
import { McpServerManager } from './mcp/mcpServerManager';
import { ProcessMonitor } from './process/processMonitor';
import { PlanRunner } from './plan';
import { Logger } from './core/logger';

// ============================================================================
// MODULE STATE
// ============================================================================

/** MCP Server Manager - retained for cleanup */
let mcpManager: McpServerManager | undefined;

/** Process Monitor - retained for cleanup */
let processMonitor: ProcessMonitor | undefined;

/** Plan Runner - retained for shutdown persistence */
let planRunner: PlanRunner | undefined;

// ============================================================================
// ACTIVATION
// ============================================================================

/**
 * Extension activation entry point.
 * 
 * Initializes all components in order:
 * 1. Load configuration
 * 2. Plan Runner (replaces JobRunner + PlanRunner)
 * 3. HTTP API server with MCP endpoint
 * 4. MCP registration with VS Code
 * 5. UI components
 * 6. Commands
 * 
 * @param context - VS Code extension context
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // ── Logger ─────────────────────────────────────────────────────────────
  const log = Logger.initialize(context);
  const extLog = Logger.for('extension');
  extLog.info('Extension activating...');

  // ── Configuration ──────────────────────────────────────────────────────
  const config = loadConfiguration();
  extLog.debug('Configuration loaded', config);

  // ── Plan Runner ─────────────────────────────────────────────────────────
  const { planRunner: runner, processMonitor: pm } = initializePlanRunner(context);
  processMonitor = pm;
  planRunner = runner;

  // ── HTTP Server ────────────────────────────────────────────────────────
  const actualPort = await initializeHttpServer(context, planRunner, config.http);

  // ── MCP Server ─────────────────────────────────────────────────────────
  // Use the actual bound port (may differ from config if port was in use)
  const httpConfigWithActualPort = actualPort !== undefined 
    ? { ...config.http, port: actualPort }
    : config.http;
  mcpManager = initializeMcpServer(context, httpConfigWithActualPort, config.mcp);

  // ── Port change detection ──────────────────────────────────────────────
  // If port changed from last startup, prompt user to enable MCP server
  if (actualPort !== undefined) {
    const LAST_PORT_KEY = 'mcpServerLastPort';
    const lastPort = context.globalState.get<number>(LAST_PORT_KEY);
    
    if (lastPort !== undefined && lastPort !== actualPort) {
      extLog.info(`MCP port changed: ${lastPort} → ${actualPort}`);
      vscode.window.showWarningMessage(
        `MCP server port changed to ${actualPort} (was ${lastPort}). You may need to re-enable the server in the MCP Servers panel.`,
        'Open MCP Servers'
      ).then(choice => {
        if (choice === 'Open MCP Servers') {
          vscode.commands.executeCommand('workbench.action.chat.listMcpServers');
        }
      });
    }
    
    context.globalState.update(LAST_PORT_KEY, actualPort);
  }

  // ── Plans view ──────────────────────────────────────────────────────────
  initializePlansView(context, planRunner);

  // ── Commands ───────────────────────────────────────────────────────────
  registerPlanCommands(context, planRunner);

  // ── Complete ───────────────────────────────────────────────────────────
  extLog.info('Extension activated successfully');
  vscode.window.showInformationMessage('Copilot Orchestrator is ready!');
}

// ============================================================================
// DEACTIVATION
// ============================================================================

/**
 * Extension deactivation handler.
 * Cleans up resources and persists state when the extension is unloaded.
 */
export function deactivate(): void {
  // Persist state synchronously before shutdown
  try {
    planRunner?.persistSync();
  } catch (e) {
    console.error('Failed to persist state on deactivate:', e);
  }
  
  // Note: mcpManager.stop() is also called by subscriptions.dispose(),
  // but it's idempotent so calling it here for safety is fine
  try {
    mcpManager?.stop();
  } catch (e) {
    console.error('Failed to stop MCP manager:', e);
  }
  
  processMonitor = undefined;
  planRunner = undefined;
}
