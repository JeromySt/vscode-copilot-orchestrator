/**
 * @fileoverview VS Code Copilot Orchestrator Extension - Main Entry Point
 * 
 * This file is the composition root for the extension. It orchestrates
 * the initialization of all components in a clean, declarative manner.
 * All logic is delegated to specialized initialization routines.
 * 
 * @module extension
 */

import * as vscode from 'vscode';
import {
  loadConfiguration,
  initializeCoreServices,
  initializeHttpServer,
  initializeMcpServer,
  initializeJobsView,
  initializePlansView,
  initializeNotebookSupport,
  createUIManager,
  initializeCopilotCli,
  registerAllCommands,
  showMcpRegistrationPrompt
} from './core/initialization';
import { McpServerManager } from './mcp/mcpServerManager';
import { ProcessMonitor } from './process/processMonitor';
import { Logger } from './core/logger';

// ============================================================================
// MODULE STATE
// ============================================================================

/** MCP Server Manager - retained for cleanup */
let mcpManager: McpServerManager | undefined;

/** Process Monitor - retained for cleanup */
let processMonitor: ProcessMonitor | undefined;

/** Job Runner - retained for shutdown persistence */
let jobRunner: import('./core/jobRunner').JobRunner | undefined;

/** Plan Runner - retained for shutdown persistence */
let planRunner: import('./core/planRunner').PlanRunner | undefined;

// ============================================================================
// ACTIVATION
// ============================================================================

/**
 * Extension activation entry point.
 * 
 * Initializes all components in order:
 * 1. Load configuration
 * 2. Core services (JobRunner, PlanRunner, ProcessMonitor)
 * 3. HTTP API server
 * 4. MCP server
 * 5. UI components (sidebar, notebooks)
 * 6. Commands
 * 7. Copilot CLI check
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

  // ── Core Services ──────────────────────────────────────────────────────
  const { runner, plans, processMonitor: pm } = initializeCoreServices(context);
  processMonitor = pm;
  jobRunner = runner;
  planRunner = plans;

  // ── HTTP Server ────────────────────────────────────────────────────────
  // Must be started BEFORE MCP registration so the endpoint is available
  await initializeHttpServer(context, runner, plans, config.http);

  // ── MCP Server ─────────────────────────────────────────────────────────
  mcpManager = initializeMcpServer(context, config.http, config.mcp);

  // ── Sidebar View ───────────────────────────────────────────────────────
  const jobsView = initializeJobsView(context, runner);

  // ── Plans View ─────────────────────────────────────────────────────────
  initializePlansView(context, plans);

  // ── Notebook Support ───────────────────────────────────────────────────
  initializeNotebookSupport(context, runner);

  // ── UI Manager ─────────────────────────────────────────────────────────
  const uiManager = createUIManager(context, runner, jobsView);

  // ── Commands ───────────────────────────────────────────────────────────
  registerAllCommands(context, runner, uiManager, processMonitor);

  // ── Copilot CLI ────────────────────────────────────────────────────────
  await initializeCopilotCli(context);

  // ── MCP Registration Prompt ────────────────────────────────────────────
  await showMcpRegistrationPrompt(context);

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
    jobRunner?.persistSync();
    planRunner?.persistSync();
  } catch (e) {
    console.error('Failed to persist state on deactivate:', e);
  }
  
  mcpManager?.stop();
  processMonitor = undefined;
  jobRunner = undefined;
  planRunner = undefined;
}
