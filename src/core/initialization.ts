/**
 * @fileoverview Extension initialization routines.
 * 
 * This module provides clean, single-responsibility initialization functions
 * for each major component of the extension. Each function handles its own
 * configuration loading, setup, and subscription management.
 * 
 * @module core/initialization
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { JobRunner, Job } from './jobRunner';
import { PlanRunner, PlanSpec } from './planRunner';
import { ProcessMonitor } from '../process/processMonitor';
import { McpServerManager, McpConfig } from '../mcp/mcpServerManager';
import { registerMcpDefinitionProvider } from '../mcp/mcpDefinitionProvider';
import { JobsViewProvider } from '../ui/viewProvider';
import { PlansViewProvider, Plan, PlanDetailPanel } from '../ui';
import { OrchestratorNotebookSerializer, registerNotebookController } from '../ui/notebook';
import { attachStatusBar } from '../ui/statusBar';
import { getJobDetailsHtml } from '../ui/templates/jobDetailsHtml';
import { ensureCopilotCliInteractive, registerCopilotCliCheck } from '../agent/cliCheck';
import { 
  registerMcpCommands, 
  registerUtilityCommands,
  registerJobCommands,
  promptMcpServerRegistration,
  DashboardPanel
} from '../commands';
import { createDashboard } from '../ui/webview';

// ============================================================================
// CONFIGURATION TYPES
// ============================================================================

/**
 * HTTP server configuration from VS Code settings.
 */
export interface HttpConfig {
  enabled: boolean;
  host: string;
  port: number;
}

/**
 * MCP server configuration from VS Code settings.
 */
export interface McpServerConfig {
  enabled: boolean;
  host: string;
  port: number;
}

/**
 * Merge configuration from VS Code settings.
 */
export interface MergeConfig {
  mode: 'merge' | 'rebase' | 'squash';
  prefer: 'ours' | 'theirs';
  pushOnSuccess: boolean;
}

/**
 * Complete extension configuration.
 */
export interface ExtensionConfig {
  http: HttpConfig;
  mcp: McpServerConfig;
  merge: MergeConfig;
  worktreeRoot: string;
  maxWorkers: number;
  copilotCli: {
    required: boolean;
    preferredInstall: 'gh' | 'npm' | 'auto';
    enforceInJobs: boolean;
  };
}

// ============================================================================
// CONFIGURATION LOADING
// ============================================================================

/**
 * Load all extension configuration from VS Code settings.
 * 
 * @returns Complete extension configuration
 */
export function loadConfiguration(): ExtensionConfig {
  const httpCfg = vscode.workspace.getConfiguration('copilotOrchestrator.http');
  const mcpCfg = vscode.workspace.getConfiguration('copilotOrchestrator.mcp');
  const mergeCfg = vscode.workspace.getConfiguration('copilotOrchestrator.merge');
  const cliCfg = vscode.workspace.getConfiguration('copilotOrchestrator.copilotCli');
  const rootCfg = vscode.workspace.getConfiguration('copilotOrchestrator');

  return {
    http: {
      enabled: httpCfg.get<boolean>('enabled', true),
      host: httpCfg.get<string>('host', 'localhost'),
      port: httpCfg.get<number>('port', 39219)
    },
    mcp: {
      // MCP is now served via HTTP endpoint, so use HTTP config
      // The 'enabled' flag controls whether MCP is registered with VS Code
      enabled: mcpCfg.get<boolean>('enabled', true),
      host: httpCfg.get<string>('host', 'localhost'),
      port: httpCfg.get<number>('port', 39219)
    },
    merge: {
      mode: mergeCfg.get<'merge' | 'rebase' | 'squash'>('mode', 'squash'),
      prefer: mergeCfg.get<'ours' | 'theirs'>('prefer', 'theirs'),
      pushOnSuccess: mergeCfg.get<boolean>('pushOnSuccess', false)
    },
    worktreeRoot: rootCfg.get<string>('worktreeRoot', '.worktrees'),
    maxWorkers: rootCfg.get<number>('maxWorkers', 0),
    copilotCli: {
      required: cliCfg.get<boolean>('required', true),
      preferredInstall: cliCfg.get<'gh' | 'npm' | 'auto'>('preferredInstall', 'auto'),
      enforceInJobs: cliCfg.get<boolean>('enforceInJobs', true)
    }
  };
}

/**
 * Get merge configuration (convenience function for other modules).
 */
export function getMergeConfig(): MergeConfig {
  return loadConfiguration().merge;
}

// ============================================================================
// CORE SERVICES
// ============================================================================

/**
 * Initialize core services (JobRunner, PlanRunner, ProcessMonitor).
 */
export function initializeCoreServices(
  context: vscode.ExtensionContext
): { runner: JobRunner; plans: PlanRunner; processMonitor: ProcessMonitor } {
  console.log('[Init] Initializing core services...');
  
  const runner = new JobRunner(context);
  const plans = new PlanRunner(runner);
  const processMonitor = new ProcessMonitor();
  
  // Attach status bar
  attachStatusBar(context, runner);
  
  console.log('[Init] Core services ready');
  return { runner, plans, processMonitor };
}

// ============================================================================
// HTTP SERVER
// ============================================================================

/**
 * Initialize the HTTP server with MCP endpoint.
 * Returns a promise that resolves when the server is listening.
 */
export async function initializeHttpServer(
  context: vscode.ExtensionContext,
  runner: JobRunner,
  plans: PlanRunner,
  config: HttpConfig
): Promise<void> {
  console.log(`[Init] Starting HTTP server on ${config.host}:${config.port}...`);
  
  // Import and start the HTTP server
  const { startHttpServerAsync } = require('../http');
  
  try {
    const server = await startHttpServerAsync(runner, plans, config.host, config.port);
    
    // Register cleanup
    context.subscriptions.push({
      dispose: () => {
        console.log('[Init] Stopping HTTP server...');
        server.close();
      }
    });
    
    console.log(`[Init] HTTP server started at http://${config.host}:${config.port}`);
    console.log(`[Init] MCP endpoint available at http://${config.host}:${config.port}/mcp`);
  } catch (error: any) {
    console.error(`[Init] Failed to start HTTP server: ${error.message}`);
    vscode.window.showErrorMessage(`Failed to start Copilot Orchestrator HTTP server: ${error.message}`);
  }
}

// ============================================================================
// MCP SERVER
// ============================================================================

/**
 * Initialize the MCP (Model Context Protocol) server.
 */
export function initializeMcpServer(
  context: vscode.ExtensionContext,
  httpConfig: HttpConfig,
  mcpConfig: McpServerConfig
): McpServerManager | undefined {
  console.log('[Init] Initializing MCP registration...');
  
  if (!mcpConfig.enabled) {
    console.log('[Init] MCP registration disabled in settings');
    return undefined;
  }

  // Get workspace path for the MCP server
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

  // MCP is served via HTTP endpoint at /mcp
  const manager = new McpServerManager(context, {
    enabled: true,
    host: httpConfig.host,
    port: httpConfig.port,
    workspacePath
  });

  manager.start();
  context.subscriptions.push({ dispose: () => manager.stop() });

  // Register with VS Code for automatic GitHub Copilot integration
  const providerDisposable = registerMcpDefinitionProvider(context, {
    host: httpConfig.host,
    port: httpConfig.port,
    workspacePath
  });
  context.subscriptions.push(providerDisposable);
  
  // Update status to indicate MCP is registered with VS Code
  manager.setRegisteredWithVSCode(true);

  console.log(`[Init] MCP registered via HTTP endpoint at http://${httpConfig.host}:${httpConfig.port}/mcp`);
  return manager;
}

// ============================================================================
// SIDEBAR & VIEWS
// ============================================================================

/**
 * Initialize the sidebar jobs view.
 */
export function initializeSidebarView(
  context: vscode.ExtensionContext,
  runner: JobRunner
): JobsViewProvider {
  console.log('[Init] Initializing sidebar view...');
  
  const jobsView = new JobsViewProvider(context);
  
  jobsView.setDataProvider({
    getJobs: () => runner.list()
  });
  
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(JobsViewProvider.viewType, jobsView)
  );

  console.log('[Init] Sidebar view ready');
  return jobsView;
}

/**
 * Initialize the sidebar plans view.
 */
export function initializePlansView(
  context: vscode.ExtensionContext,
  planRunner: PlanRunner
): PlansViewProvider {
  console.log('[Init] Initializing plans view...');
  
  const plansView = new PlansViewProvider(context);
  
  // Create data provider that uses the planRunner directly
  const loadPlans = (): Plan[] => {
    const runnerPlans = planRunner.list();
    const specs = planRunner.listSpecs ? planRunner.listSpecs() : [];
    
    return runnerPlans.map(p => {
      const spec = specs.find((s: PlanSpec) => s.id === p.id);
      const jobIdMap = planRunner.getJobIdMap ? planRunner.getJobIdMap(p.id) : undefined;
      
      return {
        id: p.id,
        name: spec?.name || p.id,
        status: p.status as Plan['status'],
        maxParallel: spec?.maxParallel || 1,
        jobs: (spec?.jobs || []).map(j => ({
          planJobId: j.id,
          jobId: jobIdMap?.get(j.id) || null,
          name: j.name,
          task: j.task,
          status: p.done.includes(j.id) ? 'completed' as const :
                  p.running.includes(j.id) ? 'running' as const :
                  p.failed.includes(j.id) ? 'failed' as const :
                  'pending' as const,
          consumesFrom: j.consumesFrom
        })),
        queued: p.queued,
        running: p.running,
        completed: p.done,
        failed: p.failed,
        startedAt: p.startedAt || null,
        endedAt: p.endedAt || null,
        baseBranch: spec?.baseBranch,
        targetBranch: spec?.targetBranch || spec?.baseBranch,
        // RI merge status
        riMergeCompleted: p.riMergeCompleted,
        // Sub-plan information from spec and state
        // Note: planRunner.list() returns PlanState where these are already converted:
        // - runningSubPlans is Record<string, string>
        // - completedSubPlans is Record<string, string>
        subPlans: spec?.subPlans,
        pendingSubPlans: p.pendingSubPlans,
        runningSubPlans: p.runningSubPlans,
        completedSubPlans: p.completedSubPlans,
        failedSubPlans: p.failedSubPlans,
        // Parent plan ID (if this is a sub-plan)
        parentPlanId: spec?.parentPlanId,
        // Aggregated work summary
        aggregatedWorkSummary: p.aggregatedWorkSummary
      };
    });
  };
  
  const getPlan = (id: string): Plan | undefined => {
    return loadPlans().find(p => p.id === id);
  };
  
  plansView.setDataProvider({
    getPlans: loadPlans,
    getPlan
  });
  
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PlansViewProvider.viewType, plansView)
  );
  
  // Refresh when plan runner state changes
  context.subscriptions.push(
    planRunner.onDidChange(() => plansView.refresh())
  );
  
  // Register plan commands
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.showPlanDetails', (planId: string) => {
      PlanDetailPanel.createOrShow(context.extensionUri, planId, getPlan);
    }),
    
    vscode.commands.registerCommand('orchestrator.cancelPlan', async (planId?: string) => {
      if (!planId) {
        const plans = loadPlans().filter(p => !['completed', 'succeeded', 'failed', 'canceled', 'partial'].includes(p.status));
        if (plans.length === 0) {
          vscode.window.showInformationMessage('No active plans to cancel');
          return;
        }
        const selected = await vscode.window.showQuickPick(
          plans.map(p => ({ label: p.name, description: p.status, id: p.id })),
          { placeHolder: 'Select a plan to cancel' }
        );
        if (!selected) return;
        planId = selected.id;
      }
      
      planRunner.cancel(planId);
      vscode.window.showInformationMessage(`Plan "${planId}" has been canceled`);
    }),
    
    vscode.commands.registerCommand('orchestrator.retryPlan', async (planId?: string) => {
      if (!planId) {
        const plans = loadPlans().filter(p => ['failed', 'partial'].includes(p.status));
        if (plans.length === 0) {
          vscode.window.showInformationMessage('No failed plans to retry');
          return;
        }
        const selected = await vscode.window.showQuickPick(
          plans.map(p => ({ label: p.name, description: `${p.status} - ${p.failed.length} failed jobs`, id: p.id })),
          { placeHolder: 'Select a plan to retry' }
        );
        if (!selected) return;
        planId = selected.id;
      }
      
      const success = planRunner.retry(planId);
      if (success) {
        vscode.window.showInformationMessage(`Plan "${planId}" retry started`);
      } else {
        vscode.window.showErrorMessage(`Failed to retry plan "${planId}"`);
      }
    }),
    
    vscode.commands.registerCommand('orchestrator.deletePlan', async (planId?: string) => {
      if (!planId) {
        const plans = loadPlans();
        if (plans.length === 0) {
          vscode.window.showInformationMessage('No plans to delete');
          return;
        }
        const selected = await vscode.window.showQuickPick(
          plans.map(p => ({ label: p.name, description: p.status, id: p.id })),
          { placeHolder: 'Select a plan to delete' }
        );
        if (!selected) return;
        planId = selected.id;
      }
      
      const plan = loadPlans().find(p => p.id === planId);
      if (!plan) {
        vscode.window.showErrorMessage(`Plan not found`);
        return;
      }
      
      const warningMsg = ['running', 'queued'].includes(plan.status)
        ? `Plan "${plan.name}" is currently ${plan.status}. It will be stopped and deleted. Continue?`
        : `Delete plan "${plan.name}"?`;
      
      const confirm = await vscode.window.showWarningMessage(warningMsg, { modal: true }, 'Delete');
      if (confirm === 'Delete') {
        const success = planRunner.delete(planId);
        if (success) {
          vscode.window.showInformationMessage(`Plan "${plan.name}" deleted`);
          plansView.refresh();
        } else {
          vscode.window.showErrorMessage(`Failed to delete plan "${plan.name}"`);
        }
      }
    }),
    
    vscode.commands.registerCommand('orchestrator.refreshPlans', () => {
      plansView.refresh();
    })
  );

  console.log('[Init] Plans view ready');
  return plansView;
}

// ============================================================================
// NOTEBOOK SUPPORT
// ============================================================================

/**
 * Initialize notebook serializer and controller.
 */
export function initializeNotebookSupport(
  context: vscode.ExtensionContext,
  runner: JobRunner
): void {
  console.log('[Init] Initializing notebook support...');
  
  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer(
      'orchestrator-notebook',
      new OrchestratorNotebookSerializer(),
      { transientOutputs: false }
    )
  );
  
  registerNotebookController(context, runner);
  console.log('[Init] Notebook support ready');
}

// ============================================================================
// UI REFRESH MANAGER
// ============================================================================

/**
 * UI state manager for dashboard and job detail panels.
 */
export interface UIManager {
  dashboard: DashboardPanel | undefined;
  jobDetailPanels: Map<string, vscode.WebviewPanel>;
  jobsView: JobsViewProvider;
  updateUI: () => void;
}

/**
 * Create UI manager with refresh functionality.
 */
export function createUIManager(
  context: vscode.ExtensionContext,
  runner: JobRunner,
  jobsView: JobsViewProvider
): UIManager {
  let dashboard: DashboardPanel | undefined;
  const jobDetailPanels = new Map<string, vscode.WebviewPanel>();

  const updateUI = (): void => {
    const jobs = runner.list();
    
    if (dashboard) {
      dashboard.update(jobs);
    }
    
    jobsView.refresh();

    for (const [jobId, panel] of jobDetailPanels.entries()) {
      const job = jobs.find(j => j.id === jobId);
      if (job) {
        const lastStatus = (panel as any)._lastStatus;
        if (lastStatus !== job.status) {
          (panel as any)._lastStatus = job.status;
          panel.webview.html = getJobDetailsHtml(job as any);
        }
      }
    }
  };

  // Periodic UI refresh
  const refreshInterval = setInterval(updateUI, 1000);
  context.subscriptions.push({ dispose: () => clearInterval(refreshInterval) });

  return {
    get dashboard() { return dashboard; },
    set dashboard(d) { dashboard = d; },
    jobDetailPanels,
    jobsView,
    updateUI
  };
}

// ============================================================================
// COPILOT CLI
// ============================================================================

/**
 * Initialize Copilot CLI check and registration.
 */
export async function initializeCopilotCli(
  context: vscode.ExtensionContext
): Promise<void> {
  console.log('[Init] Checking Copilot CLI...');
  registerCopilotCliCheck(context);
  await ensureCopilotCliInteractive('startup');
  console.log('[Init] Copilot CLI check complete');
}

// ============================================================================
// COMMAND REGISTRATION
// ============================================================================

/**
 * Register all extension commands.
 */
export function registerAllCommands(
  context: vscode.ExtensionContext,
  runner: JobRunner,
  uiManager: UIManager,
  processMonitor: ProcessMonitor
): void {
  console.log('[Init] Registering commands...');

  // MCP commands
  registerMcpCommands(context);

  // Utility commands (dashboard, etc.)
  registerUtilityCommands(context, {
    updateUI: uiManager.updateUI,
    createDashboard: (ctx) => createDashboard(ctx) as DashboardPanel,
    getDashboard: () => uiManager.dashboard,
    setDashboard: (panel) => { uiManager.dashboard = panel; }
  });

  // Job commands
  const config = loadConfiguration();
  registerJobCommands(context, {
    runner,
    processMonitor,
    jobDetailPanels: uiManager.jobDetailPanels,
    worktreeRoot: config.worktreeRoot,
    updateUI: uiManager.updateUI
  });

  console.log('[Init] Commands registered');
}

// ============================================================================
// MCP REGISTRATION
// ============================================================================

/**
 * Show MCP registration prompt if needed.
 */
export async function showMcpRegistrationPrompt(
  context: vscode.ExtensionContext
): Promise<void> {
  await promptMcpServerRegistration(context);
}
