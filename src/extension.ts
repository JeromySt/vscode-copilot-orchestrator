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
import { GlobalCapacityManager } from './core/globalCapacity';
import { registerUtilityCommands, registerReleaseCommands, registerPRLifecycleCommands } from './commands';
import { IMcpManager } from './interfaces/IMcpManager';
import type { IProcessMonitor } from './interfaces/IProcessMonitor';
import { PlanRunner } from './plan';
import { Logger } from './core/logger';
import { cleanupOrphanedWorktrees } from './core/orphanedWorktreeCleanup';
import { BranchChangeWatcher } from './git/branchWatcher';
import type { PlanInstance } from './plan/types/plan';
import { createContainer } from './composition';
import * as Tokens from './core/tokens';
import type { ServiceContainer } from './core/container';
import type { IConfigProvider } from './interfaces';
import type { IPulseEmitter } from './interfaces/IPulseEmitter';

// ============================================================================
// MODULE STATE
// ============================================================================

/** DI container - retained for service resolution */
let container: ServiceContainer | undefined;

/** MCP Server Manager - retained for cleanup */
let mcpManager: IMcpManager | undefined;

/** Process Monitor - retained for cleanup */
let processMonitor: IProcessMonitor | undefined;

/** Plan Runner - retained for shutdown persistence */
let planRunner: PlanRunner | undefined;

/** Power Manager - retained for cleanup */
let powerMgr: import('./core/powerManager').PowerManager | undefined;

/** Global Capacity Manager - retained for cleanup */
let globalCapacity: GlobalCapacityManager | undefined;

/** Gitignore Debouncer - retained for cleanup */
let gitignoreDebouncer: import('./interfaces/IGitignoreDebouncer').IGitignoreDebouncer | undefined;

/** Isolated Repo Manager - retained for cleanup */
let isolatedRepoManager: import('./interfaces/IIsolatedRepoManager').IIsolatedRepoManager | undefined;

/** Process event handlers - retained for cleanup */
let exitHandler: (() => void) | undefined;
let sigintHandler: (() => void) | undefined;
let sigtermHandler: (() => void) | undefined;

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
  // ── DI Container ───────────────────────────────────────────────────────
  container = createContainer(context);

  // ── Logger ─────────────────────────────────────────────────────────────
  // Resolve from container — this initializes Logger and wires its IConfigProvider
  container.resolve<Logger>(Tokens.ILogger);
  const extLog = Logger.for('extension');
  extLog.info('Extension activating...');

  // ── Configuration ──────────────────────────────────────────────────────
  const configProvider = container.resolve<IConfigProvider>(Tokens.IConfigProvider);
  const config = loadConfiguration(configProvider);
  extLog.debug('Configuration loaded', config);

  // ── Plan Runner ─────────────────────────────────────────────────────────
  const git = container.resolve<import('./interfaces/IGitOperations').IGitOperations>(Tokens.IGitOperations);
  const debouncer = container.resolve<import('./interfaces/IGitignoreDebouncer').IGitignoreDebouncer>(Tokens.IGitignoreDebouncer);
  gitignoreDebouncer = debouncer; // Retain for cleanup
  const { planRunner: runner, processMonitor: pm } = await initializePlanRunner(context, container, git, debouncer);
  processMonitor = pm;
  planRunner = runner;

  // ── Power Manager ──────────────────────────────────────────────────────
  const spawner = container.resolve<import('./interfaces').IProcessSpawner>(Tokens.IProcessSpawner);
  const { PowerManagerImpl } = require('./core/powerManager');
  powerMgr = new PowerManagerImpl(spawner);
  planRunner.setPowerManager(powerMgr!);
  // Register process exit handlers for wake lock cleanup
  // Store references so we can remove them in deactivate()
  const pmRef = powerMgr;
  exitHandler = () => pmRef?.releaseAll();
  sigintHandler = () => pmRef?.releaseAll();
  sigtermHandler = () => pmRef?.releaseAll();
  process.on('exit', exitHandler);
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);

  // ── Global Capacity Manager ────────────────────────────────────────────
  const globalMaxParallel = vscode.workspace.getConfiguration('copilotOrchestrator').get<number>('globalMaxParallel', 16);
  const globalCapacityManager = new GlobalCapacityManager(context.globalStorageUri.fsPath); // eslint-disable-line no-restricted-syntax -- composition root
  await globalCapacityManager.initialize();
  await globalCapacityManager.setGlobalMaxParallel(globalMaxParallel);
  planRunner.setGlobalCapacityManager(globalCapacityManager);
  globalCapacity = globalCapacityManager;
  
  // Cleanup on deactivation
  context.subscriptions.push({
    dispose: () => { void globalCapacityManager.shutdown().catch(e => extLog.error('Failed to shutdown global capacity manager', { error: e })); }
  });

  // ── MCP Server (stdio transport via IPC) ───────────────────────────────
  mcpManager = await initializeMcpServer(context, planRunner, config.mcp, container);

  // ── Release Manager ────────────────────────────────────────────────────
  const { createReleaseManager } = require('./composition');
  const releaseManager = createReleaseManager(container, planRunner);

  // ── Plans view ──────────────────────────────────────────────────────────
  const pulse = container.resolve<IPulseEmitter>(Tokens.IPulseEmitter);
  const prLifecycleManager = container.resolve<import('./interfaces/IPRLifecycleManager').IPRLifecycleManager>(Tokens.IPRLifecycleManager);
  initializePlansView(context, planRunner, pulse, prLifecycleManager, releaseManager);

  // ── Commands ───────────────────────────────────────────────────────────
  registerPlanCommands(context, planRunner, pulse, container);
  registerUtilityCommands(context);
  // Register release commands with actual releaseManager and providerDetector
  const providerDetector = container.resolve<import('./interfaces/IRemoteProviderDetector').IRemoteProviderDetector>(Tokens.IRemoteProviderDetector);
  registerReleaseCommands(context, (id: string) => releaseManager.getRelease(id), releaseManager, planRunner, providerDetector);
  // Register PR lifecycle commands
  registerPRLifecycleCommands(context, (id: string) => prLifecycleManager.getManagedPR(id));

  // ── Bulk Action Commands ───────────────────────────────────────────────
  // Register BulkPlanActions with the container now that PlanRunner is available
  const { BulkPlanActions } = require('./plan/bulkPlanActions');
  const dialogService = container.resolve<import('./interfaces').IDialogService>(Tokens.IDialogService);
  container.registerSingleton<import('./interfaces/IBulkPlanActions').IBulkPlanActions>(
    Tokens.IBulkPlanActions,
    () => new BulkPlanActions(planRunner, dialogService)
  );
  const bulkActions = container.resolve<import('./interfaces/IBulkPlanActions').IBulkPlanActions>(Tokens.IBulkPlanActions);
  const { registerBulkCommands } = require('./commands');
  registerBulkCommands(context, bulkActions);

  // ── Branch Change Watcher ──────────────────────────────────────────────
  // Watch for branch changes and notify debouncer
  const branchWatcher = new BranchChangeWatcher(Logger.for('git'), debouncer);
  await branchWatcher.initialize();
  context.subscriptions.push(branchWatcher);

  // ── .gitignore File System Watcher ─────────────────────────────────────
  // Watch for external .gitignore modifications and re-apply orchestrator entries
  const gitignoreWatcher = vscode.workspace.createFileSystemWatcher('**/.gitignore');
  
  gitignoreWatcher.onDidChange(async (uri) => {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (workspaceFolder) {
      const gitLogger = Logger.for('git');
      try {
        // Route through debouncer to avoid writes right after branch changes
        await debouncer.ensureEntries(workspaceFolder.uri.fsPath, [
          '.orchestrator/',
          '.worktrees/'
        ]);
        gitLogger.info('.gitignore re-checked after external modification', { 
          path: uri.fsPath 
        });
      } catch (error) {
        gitLogger.error('Failed to update .gitignore after external change', {
          path: uri.fsPath,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  });
  
  context.subscriptions.push(gitignoreWatcher);

  // ── Orphaned Worktree Cleanup ──────────────────────────────────────────
  // Trigger cleanup asynchronously after extension is fully activated
  triggerOrphanedWorktreeCleanup(planRunner, context, git).catch(err => {
    extLog.warn('Orphaned worktree cleanup failed', { error: err.message });
  });

  // ── Isolated Repo Cleanup ──────────────────────────────────────────────
  // Initialize isolated repo manager and trigger orphan cleanup
  isolatedRepoManager = container.resolve<import('./interfaces/IIsolatedRepoManager').IIsolatedRepoManager>(Tokens.IIsolatedRepoManager);
  triggerOrphanedIsolatedRepoCleanup(isolatedRepoManager).catch(err => {
    extLog.warn('Orphaned isolated repo cleanup failed', { error: err.message });
  });

  // ── CLI Availability Check ─────────────────────────────────────────────
  // Check if Copilot CLI is available and offer setup if needed
  const { checkCopilotCliOnStartup } = await import('./agent/cliCheck');
  checkCopilotCliOnStartup().catch(err => {
    extLog.warn('CLI startup check failed', { error: err.message });
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
  context: vscode.ExtensionContext,
  git: import('./interfaces/IGitOperations').IGitOperations
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
    git,
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

/**
 * Clean up orphaned isolated repository clones in the background.
 * Runs asynchronously to not block extension startup.
 * 
 * @param manager - The isolated repo manager
 */
async function triggerOrphanedIsolatedRepoCleanup(
  manager: import('./interfaces/IIsolatedRepoManager').IIsolatedRepoManager
): Promise<void> {
  const log = Logger.for('git');
  
  // Small delay to let extension fully initialize
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  log.info('Starting orphaned isolated repo cleanup');
  
  try {
    const cleanedCount = await manager.cleanupAll();
    
    if (cleanedCount > 0) {
      log.info('Orphaned isolated repo cleanup complete', { cleanedCount });
      
      // Show info message if significant cleanup was done
      if (cleanedCount >= 3) {
        vscode.window.showInformationMessage(
          `Copilot Orchestrator: Cleaned up ${cleanedCount} orphaned isolated repositories.`
        );
      }
    } else {
      log.debug('No orphaned isolated repositories found');
    }
  } catch (err: any) {
    log.error('Orphaned isolated repo cleanup failed', { error: err.message });
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
  // Remove process listeners to prevent accumulation across reloads
  if (exitHandler) { process.removeListener('exit', exitHandler); exitHandler = undefined; }
  if (sigintHandler) { process.removeListener('SIGINT', sigintHandler); sigintHandler = undefined; }
  if (sigtermHandler) { process.removeListener('SIGTERM', sigtermHandler); sigtermHandler = undefined; }

  // Release all wake locks
  powerMgr?.releaseAll();
  
  // Persist state synchronously before shutdown
  try {
    planRunner?.persistSync();
  } catch (e) {
    console.error('Failed to persist state on deactivate:', e);
  }
  
  // Shutdown global capacity manager
  void globalCapacity?.shutdown().catch((e: unknown) => {
    console.error('Failed to shutdown global capacity manager:', e);
  });
  
  // Dispose gitignore debouncer
  try {
    gitignoreDebouncer?.dispose();
  } catch (e) {
    console.error('Failed to dispose gitignore debouncer:', e);
  }

  // Cleanup isolated repositories
  void isolatedRepoManager?.cleanupAll().catch((e: unknown) => {
    console.error('Failed to cleanup isolated repositories:', e);
  });
  
  // Note: mcpManager.stop() is also called by subscriptions.dispose(),
  // but it's idempotent so calling it here for safety is fine
  try {
    mcpManager?.stop();
  } catch (e) {
    console.error('Failed to stop MCP manager:', e);
  }
  
  processMonitor = undefined;
  planRunner = undefined;
  powerMgr = undefined;
  gitignoreDebouncer = undefined;
}
