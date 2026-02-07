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
  initializeMcpServer,
  initializePlansView,
  registerPlanCommands,
} from './core/planInitialization';
import { IMcpManager } from './interfaces/IMcpManager';
import { ProcessMonitor } from './process/processMonitor';
import { PlanRunner } from './plan';
import { Logger } from './core/logger';

// ============================================================================
// MODULE STATE
// ============================================================================

/** MCP Server Manager - retained for cleanup */
let mcpManager: IMcpManager | undefined;

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
 * 3. MCP registration with VS Code (stdio transport)
 * 4. UI components
 * 5. Commands
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

  // ── MCP Server (stdio transport via IPC) ───────────────────────────────
  mcpManager = await initializeMcpServer(context, planRunner, config.mcp);

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
