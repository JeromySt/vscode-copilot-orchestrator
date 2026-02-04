/**
 * @fileoverview VS Code Copilot Orchestrator Extension - Main Entry Point
 * 
 * This file is the composition root for the extension. It orchestrates
 * the initialization of all components using the DAG-based system.
 * 
 * Everything is a DAG - even a single job.
 * 
 * @module extension
 */

import * as vscode from 'vscode';
import {
  loadConfiguration,
  initializeDagRunner,
  initializeHttpServer,
  initializeMcpServer,
  initializeDagsView,
  registerDagCommands,
} from './core/dagInitialization';
import { McpServerManager } from './mcp/mcpServerManager';
import { ProcessMonitor } from './process/processMonitor';
import { DagRunner } from './dag';
import { Logger } from './core/logger';

// ============================================================================
// MODULE STATE
// ============================================================================

/** MCP Server Manager - retained for cleanup */
let mcpManager: McpServerManager | undefined;

/** Process Monitor - retained for cleanup */
let processMonitor: ProcessMonitor | undefined;

/** DAG Runner - retained for shutdown persistence */
let dagRunner: DagRunner | undefined;

// ============================================================================
// ACTIVATION
// ============================================================================

/**
 * Extension activation entry point.
 * 
 * Initializes all components in order:
 * 1. Load configuration
 * 2. DAG runner (replaces JobRunner + PlanRunner)
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

  // ── DAG Runner ─────────────────────────────────────────────────────────
  const { dagRunner: runner, processMonitor: pm } = initializeDagRunner(context);
  processMonitor = pm;
  dagRunner = runner;

  // ── HTTP Server ────────────────────────────────────────────────────────
  await initializeHttpServer(context, dagRunner, config.http);

  // ── MCP Server ─────────────────────────────────────────────────────────
  mcpManager = initializeMcpServer(context, config.http, config.mcp);

  // ── DAGs View ──────────────────────────────────────────────────────────
  initializeDagsView(context, dagRunner);

  // ── Commands ───────────────────────────────────────────────────────────
  registerDagCommands(context, dagRunner);

  // ── Complete ───────────────────────────────────────────────────────────
  extLog.info('Extension activated successfully');
  vscode.window.showInformationMessage('Copilot Orchestrator is ready! (DAG Mode)');
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
    dagRunner?.persistSync();
  } catch (e) {
    console.error('Failed to persist state on deactivate:', e);
  }
  
  mcpManager?.stop();
  processMonitor = undefined;
  dagRunner = undefined;
}
