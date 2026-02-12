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
import * as path from 'path';
import * as fs from 'fs';
import {
  loadConfiguration,
  initializePlanRunner,
  initializeMcpServer,
  initializePlansView,
  registerPlanCommands,
} from './core/planInitialization';
import { registerUtilityCommands } from './commands';
import { IMcpManager } from './interfaces/IMcpManager';
import { ProcessMonitor } from './process/processMonitor';
import { PlanRunner } from './plan';
import { Logger } from './core/logger';
import { cleanupOrphanedWorktrees, CleanupResult } from './core/orphanedWorktreeCleanup';
import type { PlanInstance } from './plan/types/plan';

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
  registerUtilityCommands(context);

  // ── Orphaned Worktree Cleanup ──────────────────────────────────────────
  // Trigger cleanup asynchronously after extension is fully activated
  triggerOrphanedWorktreeCleanup(planRunner, context).catch(err => {
    extLog.warn('Orphaned worktree cleanup failed', { error: err.message });
  });

  // ── Complete ───────────────────────────────────────────────────────────
  extLog.info('Extension activated successfully');
  vscode.window.showInformationMessage('Copilot Orchestrator is ready!');
}

// ============================================================================
// ORPHANED WORKTREE CLEANUP
// ============================================================================

/**
 * Clean up orphaned worktree directories in the background.
 * Runs asynchronously to not block extension startup.
 * 
 * @param planRunner - The plan runner to query active plans
 * @param context - VS Code extension context
 */
async function triggerOrphanedWorktreeCleanup(
  planRunner: PlanRunner,
  context: vscode.ExtensionContext
): Promise<void> {
  const log = Logger.for('git');
  
  // Check if cleanup is enabled in configuration
  const config = vscode.workspace.getConfiguration('copilotOrchestrator');
  if (!config.get('cleanupOrphanedWorktrees', true)) {
    log.debug('Orphaned worktree cleanup disabled via configuration');
    return;
  }
  
  // Small delay to let extension fully initialize
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Build map of active plans
  const activePlans = new Map<string, PlanInstance>();
  for (const plan of planRunner.getAll()) {
    activePlans.set(plan.id, plan);
  }
  
  // Collect unique repo paths from plans
  const repoPaths = new Set<string>();
  for (const plan of planRunner.getAll()) {
    if (plan.repoPath) {
      repoPaths.add(plan.repoPath);
    }
  }
  
  // Also add current workspace folders
  for (const folder of vscode.workspace.workspaceFolders || []) {
    // Check if folder has .worktrees directory
    const worktreesDir = path.join(folder.uri.fsPath, '.worktrees');
    if (fs.existsSync(worktreesDir)) {
      repoPaths.add(folder.uri.fsPath);
    }
  }
  
  if (repoPaths.size === 0) {
    log.debug('No repositories with .worktrees directories found');
    return; // Nothing to clean
  }
  
  log.info('Starting orphaned worktree cleanup', { repos: repoPaths.size });
  
  const result = await cleanupOrphanedWorktrees({
    repoPaths: Array.from(repoPaths),
    activePlans,
    logger: (msg) => log.debug(msg)
  });
  
  if (result.orphanedCleaned > 0) {
    log.info('Orphaned worktree cleanup complete', {
      scannedRepos: result.scannedRepos,
      orphanedFound: result.orphanedFound,
      orphanedCleaned: result.orphanedCleaned,
      errors: result.errors.length
    });
    
    // Show info message if significant cleanup was done
    if (result.orphanedCleaned >= 3) {
      vscode.window.showInformationMessage(
        `Copilot Orchestrator: Cleaned up ${result.orphanedCleaned} orphaned worktree directories.`
      );
    }
  } else {
    log.debug('No orphaned worktrees found');
  }
  
  if (result.errors.length > 0) {
    log.warn('Orphaned worktree cleanup had errors', { errors: result.errors });
  }
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
