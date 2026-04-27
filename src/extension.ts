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
import { registerUtilityCommands, registerReleaseCommands, registerPRLifecycleCommands, registerBulkCommands } from './commands';
import { IMcpManager } from './interfaces/IMcpManager';
import type { IProcessMonitor } from './interfaces/IProcessMonitor';
import { PlanRunner } from './plan';
import { Logger } from './core/logger';
import { cleanupOrphanedWorktrees } from './core/orphanedWorktreeCleanup';
import { BranchChangeWatcher } from './vscode/branchWatcher';
import type { PlanInstance } from './plan/types/plan';
import { createContainer, createReleaseManager, createBulkPlanActions } from './composition';
import * as Tokens from './core/tokens';
import type { ServiceContainer } from './core/container';
import type { IConfigProvider } from './interfaces';
import type { IPulseEmitter } from './interfaces/IPulseEmitter';
import type { IOrchestrationEngine } from './interfaces/IOrchestrationEngine';
import type { IDotNetDaemonManager } from './interfaces/IDotNetDaemonManager';
import { TsOrchestrationEngine } from './core/tsEngine';
import { DotNetOrchestrationEngine } from './core/dotnetEngine';
import { DotNetDaemonManager } from './core/dotnetDaemonManager';
import { setMcpEngineKind, registerMcpDefinitionProvider } from './mcp/mcpDefinitionProvider';

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

/** Orchestration Engine - retained for shutdown */
let engine: IOrchestrationEngine | undefined;

/** .NET Daemon Manager - retained for cleanup (only when dotnet engine active) */
let daemonManager: IDotNetDaemonManager | undefined;

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

  // ── Engine Selection ─────────────────────────────────────────────────
  const useDotNet = configProvider.getConfig<boolean>('copilotOrchestrator', 'experimental.useDotNetEngine', false);

  if (useDotNet) {
    // .NET engine: skip TS PlanRunner entirely — all plan operations go through
    // the .NET daemon via named pipes.
    extLog.info('Using .NET engine (experimental)');
    const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const workspaceId = Buffer.from(repoRoot).toString('base64url').slice(0, 16);
    daemonManager = new DotNetDaemonManager(context.extensionPath, workspaceId);
    engine = new DotNetOrchestrationEngine(daemonManager, repoRoot);
    context.subscriptions.push(daemonManager);
  } else {
    // TS engine: initialize the full PlanRunner pipeline.
    const git = container.resolve<import('./interfaces/IGitOperations').IGitOperations>(Tokens.IGitOperations);
    const debouncer = container.resolve<import('./interfaces/IGitignoreDebouncer').IGitignoreDebouncer>(Tokens.IGitignoreDebouncer);
    gitignoreDebouncer = debouncer;
    const { planRunner: runner, processMonitor: pm } = await initializePlanRunner(context, container, git, debouncer);
    processMonitor = pm;
    planRunner = runner;
    engine = new TsOrchestrationEngine(runner);
  }

  container.registerSingleton<IOrchestrationEngine>(Tokens.IOrchestrationEngine, () => engine!);
  await engine.initialize();

  // Sync MCP server definition to match the active engine
  setMcpEngineKind(useDotNet ? 'dotnet' : 'typescript');

  // ── Power Manager ──────────────────────────────────────────────────────
  const spawner = container.resolve<import('./interfaces').IProcessSpawner>(Tokens.IProcessSpawner);
  const { PowerManagerImpl } = require('./core/powerManager');
  powerMgr = new PowerManagerImpl(spawner);
  if (planRunner) {
    planRunner.setPowerManager(powerMgr!);
  }
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
  if (planRunner) {
    planRunner.setGlobalCapacityManager(globalCapacityManager);
  }
  globalCapacity = globalCapacityManager;
  
  // Cleanup on deactivation
  context.subscriptions.push({
    dispose: () => { void globalCapacityManager.shutdown().catch(e => extLog.error('Failed to shutdown global capacity manager', { error: e })); }
  });

  // ── MCP Server ─────────────────────────────────────────────────────────
  if (planRunner) {
    // TS engine: start the IPC server + register MCP definition provider
    mcpManager = await initializeMcpServer(context, planRunner, config.mcp, container);
  } else {
    // .NET engine: register the MCP definition provider directly.
    // VS Code will spawn AiOrchestrator.Cli.exe mcp serve as the MCP server.
    // No IPC server needed — the .NET binary handles MCP protocol natively.
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const providerDisposable = registerMcpDefinitionProvider(context, workspacePath, '', '');
    context.subscriptions.push(providerDisposable);
  }

  // ── Release Manager (experimental) ──────────────────────────────────────
  const releaseFeatureEnabled = vscode.workspace.getConfiguration('copilotOrchestrator').get<boolean>('experimental.enableReleaseManagement', false);
  const releaseManager = (releaseFeatureEnabled && planRunner) ? createReleaseManager(container, planRunner) : undefined;

  // ── Plans view ──────────────────────────────────────────────────────────
  const pulse = container.resolve<IPulseEmitter>(Tokens.IPulseEmitter);
  const prLifecycleManager = releaseFeatureEnabled
    ? container.resolve<import('./interfaces/IPRLifecycleManager').IPRLifecycleManager>(Tokens.IPRLifecycleManager)
    : undefined;

  // The plans view / tree / producers use duck-typed access to plan data.
  // When using the .NET engine, we pass the engine directly — it implements
  // getAll(), get(), getByStatus(), getStatus(), getGlobalStats() which are
  // the methods the UI producers actually call. We shim the missing PlanRunner
  // methods (getStateMachine, getEffectiveEndedAt, getGlobalCapacityStats)
  // so the UI doesn't crash.
  const planDataSource = planRunner ?? Object.assign(engine!, {
    getStateMachine: () => undefined,
    getEffectiveEndedAt: () => undefined,
    getEffectiveStartedAt: () => undefined,
    getGlobalCapacityStats: () => Promise.resolve(null),
    getNodeLogs: () => '',
    getNodeLogFilePath: () => undefined,
    getNodeAttempt: () => null,
    getNodeAttempts: () => [],
    getProcessStats: () => Promise.resolve({ pid: null, running: false, tree: [], duration: null }),
    getAllProcessStats: () => Promise.resolve({}),
    getRecursiveStatusCounts: () => ({ totalNodes: 0, counts: {} }),
    setExecutor: () => {},
    setGlobalCapacityManager: () => {},
  });

  initializePlansView(context, planDataSource as any, pulse, prLifecycleManager, releaseManager);

  // ── Commands ───────────────────────────────────────────────────────────
  registerPlanCommands(context, planDataSource as any, pulse, container);
  registerUtilityCommands(context);
  // Register release commands (experimental — gated)
  if (releaseFeatureEnabled && releaseManager) {
    const providerDetector = container.resolve<import('./interfaces/IRemoteProviderDetector').IRemoteProviderDetector>(Tokens.IRemoteProviderDetector);
    registerReleaseCommands(context, (id: string) => releaseManager.getRelease(id), releaseManager, planDataSource as any, providerDetector, pulse);
    if (prLifecycleManager) {
      registerPRLifecycleCommands(context, (id: string) => prLifecycleManager.getManagedPR(id));
    }
  }

  // ── Bulk Action Commands ───────────────────────────────────────────────
  {
    let planRepo: import('./interfaces').IPlanRepository | undefined;
    try { planRepo = container.resolve<import('./interfaces').IPlanRepository>(Tokens.IPlanRepository); } catch { /* not registered yet */ }
    const bulkActions = createBulkPlanActions(container, planDataSource as any, planRepo);
    const dialogService = container.resolve<import('./interfaces').IDialogService>(Tokens.IDialogService);
    registerBulkCommands(context, bulkActions, dialogService);
  }

  // ── Branch Change Watcher ──────────────────────────────────────────────
  // Watch for branch changes and notify debouncer (TS engine only — .NET handles its own gitignore)
  if (gitignoreDebouncer) {
    const branchWatcher = new BranchChangeWatcher(Logger.for('git'), gitignoreDebouncer);
    await branchWatcher.initialize();
    context.subscriptions.push(branchWatcher);

    // ── .gitignore File System Watcher ─────────────────────────────────────
    const gitignoreWatcher = vscode.workspace.createFileSystemWatcher('**/.gitignore');
    
    gitignoreWatcher.onDidChange(async (uri) => {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
      if (workspaceFolder) {
        const gitLogger = Logger.for('git');
        try {
          await gitignoreDebouncer!.ensureEntries(workspaceFolder.uri.fsPath, [
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
  }

  // ── Orphaned Worktree Cleanup ──────────────────────────────────────────
  if (planRunner) {
    const git = container.resolve<import('./interfaces/IGitOperations').IGitOperations>(Tokens.IGitOperations);
    triggerOrphanedWorktreeCleanup(planRunner, context, git).catch(err => {
      extLog.warn('Orphaned worktree cleanup failed', { error: err.message });
    });
  }

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
  
  // Shut down engine and persist state synchronously before shutdown
  try {
    engine?.persistSync();
  } catch (e) {
    console.error('Failed to persist engine state on deactivate:', e);
  }
  try {
    planRunner?.persistSync();
  } catch (e) {
    console.error('Failed to persist state on deactivate:', e);
  }
  void engine?.shutdown().catch((e: unknown) => {
    console.error('Failed to shutdown engine:', e);
  });
  
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
  engine = undefined;
  daemonManager = undefined;
}
