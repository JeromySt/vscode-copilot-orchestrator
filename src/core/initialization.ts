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
import { JobRunner, Job } from './jobRunner';
import { PlanRunner } from './planRunner';
import { ProcessMonitor } from '../process/processMonitor';
import { McpServerManager, McpConfig } from '../mcp/mcpServerManager';
import { registerMcpDefinitionProvider } from '../mcp/mcpDefinitionProvider';
import { startHttp } from '../http/httpServer';
import { JobsViewProvider } from '../ui/viewProvider';
import { OrchestratorNotebookSerializer, registerNotebookController } from '../ui/notebook';
import { attachStatusBar } from '../ui/statusBar';
import { getJobDetailsHtml } from '../ui/templates/jobDetailsHtml';
import { ensureCopilotCliInteractive, registerCopilotCliCheck } from '../agent/cliCheck';
import { 
  registerMcpCommands, 
  registerUtilityCommands,
  promptMcpServerRegistration,
  DashboardPanel
} from '../commands';
import { createDashboard } from '../ui/webview';
import { detectWorkspace } from './detector';
import { randomUUID } from 'crypto';

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
      port: httpCfg.get<number>('port', 39218)
    },
    mcp: {
      enabled: mcpCfg.get<boolean>('enabled', true),
      host: mcpCfg.get<string>('host', 'localhost'),
      port: mcpCfg.get<number>('port', 39219)
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
 * Initialize the HTTP REST API server.
 */
export function initializeHttpServer(
  context: vscode.ExtensionContext,
  runner: JobRunner,
  plans: PlanRunner,
  config: HttpConfig
): void {
  console.log('[Init] Initializing HTTP server...');
  
  if (!config.enabled) {
    console.log('[Init] HTTP server disabled in settings');
    return;
  }

  try {
    const server = startHttp(runner, plans, config.host, config.port);
    context.subscriptions.push({ dispose: () => server.close() });
    console.log(`[Init] HTTP server started on ${config.host}:${config.port}`);
  } catch (error) {
    console.error('[Init] Failed to start HTTP server:', error);
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
  console.log('[Init] Initializing MCP server...');
  
  if (!mcpConfig.enabled) {
    console.log('[Init] MCP server disabled in settings');
    return undefined;
  }

  const serverPath = vscode.Uri.joinPath(
    context.extensionUri, 
    'server', 
    'mcp-server.js'
  ).fsPath;

  const manager = new McpServerManager(context, {
    enabled: true,
    host: mcpConfig.host,
    port: mcpConfig.port,
    orchestratorHost: httpConfig.host,
    orchestratorPort: httpConfig.port,
    serverPath
  });

  manager.start();
  context.subscriptions.push({ dispose: () => manager.stop() });

  // Register with VS Code for automatic GitHub Copilot integration
  const providerDisposable = registerMcpDefinitionProvider(context, {
    host: mcpConfig.host,
    port: mcpConfig.port,
    orchestratorPort: httpConfig.port,
    serverPath
  });
  context.subscriptions.push(providerDisposable);
  
  // Update status to indicate MCP is registered with VS Code
  // even if the HTTP server has issues
  manager.setRegisteredWithVSCode(true);

  console.log(`[Init] MCP server started on ${mcpConfig.host}:${mcpConfig.port}`);
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
  registerJobCommands(context, runner, uiManager, processMonitor);

  console.log('[Init] Commands registered');
}

/**
 * Register job-related commands.
 */
function registerJobCommands(
  context: vscode.ExtensionContext,
  runner: JobRunner,
  uiManager: UIManager,
  processMonitor: ProcessMonitor
): void {
  const { updateUI, jobDetailPanels } = uiManager;
  const config = loadConfiguration();

  // Start Job
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.startJob', async () => {
      await handleStartJob(runner, config.worktreeRoot);
    })
  );

  // Create Job (alias)
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.createJob', () => {
      vscode.commands.executeCommand('orchestrator.startJob');
    })
  );

  // Retry Job
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.retryJob', async (jobId?: string, updatedWorkContext?: string) => {
      await handleRetryJob(runner, jobId, updatedWorkContext, updateUI, jobDetailPanels);
    })
  );

  // Cancel Job
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.cancelJob', async (jobId?: string) => {
      await handleCancelJob(runner, jobId, updateUI);
    })
  );

  // Delete Job
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.deleteJob', async (jobId?: string) => {
      await handleDeleteJob(runner, jobId, updateUI);
    })
  );

  // Open Job Worktree
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.openJobWorktree', async (jobId?: string) => {
      await handleOpenWorktree(runner, jobId);
    })
  );

  // Merge Completed Job
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.mergeCompletedJob', async () => {
      await handleMergeJob(runner);
    })
  );

  // Show Job Details
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.showJobDetails', async (jobId?: string) => {
      await handleShowJobDetails(runner, jobId, jobDetailPanels, processMonitor);
    })
  );

  // Show Job Section
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.showJobSection', async (jobId?: string, section?: string) => {
      await vscode.commands.executeCommand('orchestrator.showJobDetails', jobId);
      if (section && jobId) {
        const panel = jobDetailPanels.get(jobId);
        if (panel) {
          panel.webview.postMessage({ command: 'scrollToSection', section });
        }
      }
    })
  );
}

// ============================================================================
// COMMAND HANDLERS
// ============================================================================

async function handleStartJob(runner: JobRunner, worktreeRoot: string): Promise<void> {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!ws) {
    vscode.window.showErrorMessage('Open a workspace with a Git repo.');
    return;
  }

  const det = detectWorkspace(ws);
  const jobName = await vscode.window.showInputBox({
    prompt: 'Job name (for display)',
    value: `job-${Date.now()}`
  }) || `job-${Date.now()}`;

  const { execSync } = require('child_process');
  let currentBranch = 'main';
  let defaultBranch = 'main';

  try {
    currentBranch = execSync('git branch --show-current', { cwd: ws, encoding: 'utf-8' }).trim();
    try {
      const remoteHead = execSync('git symbolic-ref refs/remotes/origin/HEAD 2>nul', { cwd: ws, encoding: 'utf-8' }).trim();
      defaultBranch = remoteHead.replace('refs/remotes/origin/', '');
    } catch {
      const branches = execSync('git branch -r', { cwd: ws, encoding: 'utf-8' });
      if (branches.includes('origin/main')) defaultBranch = 'main';
      else if (branches.includes('origin/master')) defaultBranch = 'master';
      else if (branches.includes('origin/develop')) defaultBranch = 'develop';
    }
  } catch (e) {
    console.error('Failed to get git branch info:', e);
  }

  const isOnDefaultBranch = currentBranch === defaultBranch;
  let baseBranch = currentBranch;
  let targetBranch = currentBranch;

  if (isOnDefaultBranch) {
    const friendlyName = jobName.replace(/\W+/g, '-').toLowerCase();
    targetBranch = `feature/${friendlyName}`;
    baseBranch = defaultBranch;
  }

  const jobId = randomUUID();

  runner.enqueue({
    id: jobId,
    name: jobName,
    task: 'generic-work',
    inputs: {
      repoPath: ws,
      baseBranch,
      targetBranch,
      worktreeRoot,
      instructions: ''
    },
    policy: {
      useJust: true,
      steps: {
        prechecks: det.steps.pre,
        work: det.steps.work,
        postchecks: det.steps.post
      }
    }
  });

  vscode.window.showInformationMessage(`Job "${jobName}" queued on ${targetBranch} (ID: ${jobId.substring(0, 8)}...)`);
}

async function handleRetryJob(
  runner: JobRunner,
  jobId: string | undefined,
  updatedWorkContext: string | undefined,
  updateUI: () => void,
  jobDetailPanels: Map<string, vscode.WebviewPanel>
): Promise<void> {
  if (!jobId) {
    const jobs = runner.list().filter(j => j.status === 'failed' || j.status === 'canceled');
    if (jobs.length === 0) {
      vscode.window.showInformationMessage('No failed or canceled jobs to retry');
      return;
    }
    const items = jobs.map(j => ({
      label: j.name,
      description: `${j.status} at ${j.currentStep || 'unknown step'} - ${j.id.substring(0, 8)}...`,
      jobId: j.id
    }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select job to retry' });
    if (!pick) return;
    jobId = (pick as any).jobId;
  }

  const job = runner.list().find(j => j.id === jobId);
  if (!job || !jobId) return;

  (runner as any).retry(jobId, updatedWorkContext);
  const contextMsg = updatedWorkContext ? ' with updated context' : ' with AI analysis';
  vscode.window.showInformationMessage(`Job "${job.name}" queued for retry${contextMsg}`);
  updateUI();

  const panel = jobDetailPanels.get(jobId);
  if (panel) {
    const updatedJob = runner.list().find(j => j.id === jobId);
    if (updatedJob) {
      panel.webview.html = getJobDetailsHtml(updatedJob as any);
    }
  }
}

async function handleCancelJob(
  runner: JobRunner,
  jobId: string | undefined,
  updateUI: () => void
): Promise<void> {
  if (!jobId) {
    const items = runner.list()
      .filter(j => j.status === 'running' || j.status === 'queued')
      .map(j => ({ label: j.name, description: `${j.status} - ${j.id.substring(0, 8)}...`, jobId: j.id }));

    if (items.length === 0) {
      vscode.window.showInformationMessage('No running or queued jobs to cancel');
      return;
    }

    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select a job to cancel' });
    if (!pick) return;
    jobId = (pick as any).jobId;
  }

  const job = runner.list().find(j => j.id === jobId);
  (runner as any).cancel(jobId);
  vscode.window.showWarningMessage(`Job "${job?.name || jobId}" canceled`);
  updateUI();
}

async function handleDeleteJob(
  runner: JobRunner,
  jobId: string | undefined,
  updateUI: () => void
): Promise<void> {
  if (!jobId) {
    const jobs = runner.list();
    const items = jobs.map(j => ({ label: j.name, description: `${j.status} - ${j.id.substring(0, 8)}...`, jobId: j.id }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select job to delete' });
    if (!pick) return;
    jobId = (pick as any).jobId;
  }

  const job = runner.list().find(j => j.id === jobId);
  if (!job) {
    vscode.window.showErrorMessage(`Job ${jobId} not found`);
    return;
  }

  const warningMsg = job.status === 'running'
    ? `Job "${job.name}" is currently running. It will be stopped and deleted. Continue?`
    : `Delete job "${job.name}"?`;

  const confirm = await vscode.window.showWarningMessage(warningMsg, { modal: true }, 'Delete');
  if (confirm === 'Delete') {
    const success = (runner as any).delete(jobId);
    if (success) {
      vscode.window.showInformationMessage(`Job "${job.name}" deleted`);
      updateUI();
    } else {
      vscode.window.showErrorMessage(`Failed to delete job "${job.name}"`);
    }
  }
}

async function handleOpenWorktree(runner: JobRunner, jobId: string | undefined): Promise<void> {
  if (!jobId) {
    const jobs = runner.list();
    const items = jobs.map(j => ({ label: j.name, description: `${j.status} - ${j.id.substring(0, 8)}...`, jobId: j.id }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select job worktree to open' });
    if (!pick) return;
    jobId = (pick as any).jobId;
  }

  const job = runner.list().find(j => j.id === jobId);
  if (!job) return;

  const path = require('path');
  const worktreePath = path.join(job.inputs.repoPath, job.inputs.worktreeRoot, job.id);
  const uri = vscode.Uri.file(worktreePath);

  const choice = await vscode.window.showInformationMessage(
    `Open worktree for "${job.name}"?`,
    'Open in New Window',
    'Open in Current Window',
    'Reveal in Explorer'
  );

  if (choice === 'Open in New Window') {
    vscode.commands.executeCommand('vscode.openFolder', uri, true);
  } else if (choice === 'Open in Current Window') {
    vscode.commands.executeCommand('vscode.openFolder', uri, false);
  } else if (choice === 'Reveal in Explorer') {
    vscode.commands.executeCommand('revealFileInOS', uri);
  }
}

async function handleMergeJob(runner: JobRunner): Promise<void> {
  const jobs = runner.list().filter(j => j.status === 'succeeded');
  if (!jobs.length) {
    vscode.window.showInformationMessage('No succeeded jobs to merge.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    jobs.map(j => ({ label: j.id, description: j.inputs.targetBranch })),
    { placeHolder: 'Pick job to merge into base' }
  );
  if (!pick) return;
  vscode.window.showInformationMessage(`Job ${pick.label} already merged (or handled by auto-merge).`);
}

async function handleShowJobDetails(
  runner: JobRunner,
  jobId: string | undefined,
  jobDetailPanels: Map<string, vscode.WebviewPanel>,
  processMonitor: ProcessMonitor
): Promise<void> {
  if (!jobId) {
    const jobs = runner.list();
    if (jobs.length === 0) {
      vscode.window.showInformationMessage('No jobs available');
      return;
    }

    const items = jobs.map(j => ({
      label: j.name,
      description: `${j.status} - ${j.id.substring(0, 8)}...`,
      detail: j.task,
      jobId: j.id
    }));

    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select a job to inspect' });
    if (!pick) return;
    jobId = (pick as any).jobId;
  }

  const job = runner.list().find(j => j.id === jobId);
  if (!job || !jobId) {
    vscode.window.showErrorMessage(`Job ${jobId} not found`);
    return;
  }

  // Check if panel already exists
  const existingPanel = jobDetailPanels.get(jobId);
  if (existingPanel) {
    existingPanel.reveal(vscode.ViewColumn.Beside);
    existingPanel.webview.html = getJobDetailsHtml(job as any);
    return;
  }

  // Create new panel
  const panel = vscode.window.createWebviewPanel(
    'jobDetails',
    `Job: ${job.name}`,
    vscode.ViewColumn.One,
    { enableScripts: true, enableCommandUris: true }
  );

  jobDetailPanels.set(jobId, panel);
  (panel as any)._lastStatus = job.status;

  panel.onDidDispose(() => {
    jobDetailPanels.delete(jobId!);
  });

  // Set up message handler
  setupJobDetailMessageHandler(panel, runner, jobId, jobDetailPanels, processMonitor);

  panel.webview.html = getJobDetailsHtml(job as any);

  // Auto-refresh for running jobs
  if (job.status === 'running' || job.status === 'queued') {
    setupAutoRefresh(panel, runner, jobId, jobDetailPanels);
  }
}

function setupJobDetailMessageHandler(
  panel: vscode.WebviewPanel,
  runner: JobRunner,
  jobId: string,
  jobDetailPanels: Map<string, vscode.WebviewPanel>,
  processMonitor: ProcessMonitor
): void {
  const fs = require('fs');

  panel.webview.onDidReceiveMessage(async message => {
    switch (message.command) {
      case 'getLogContent':
        handleGetLogContent(panel, message);
        break;
      case 'copyToClipboard':
        await vscode.env.clipboard.writeText(message.text);
        vscode.window.showInformationMessage(`Copied to clipboard: ${message.text.substring(0, 12)}...`);
        break;
      case 'openLog':
        await handleOpenLog(runner, message, jobId);
        break;
      case 'cancelJob':
        await vscode.commands.executeCommand('orchestrator.cancelJob', message.jobId);
        break;
      case 'retryJob':
        await vscode.commands.executeCommand('orchestrator.retryJob', message.jobId);
        break;
      case 'deleteJob':
        await vscode.commands.executeCommand('orchestrator.deleteJob', message.jobId);
        if (!runner.list().find(j => j.id === message.jobId)) {
          jobDetailPanels.delete(message.jobId);
          panel.dispose();
        }
        break;
      case 'retryAttempt':
        await vscode.commands.executeCommand('orchestrator.retryJob', message.jobId);
        break;
      case 'getProcessStats':
        await handleGetProcessStats(panel, runner, jobId, processMonitor);
        break;
    }
  });
}

function handleGetLogContent(panel: vscode.WebviewPanel, message: any): void {
  const fs = require('fs');
  const { logPath, section } = message;

  if (!fs.existsSync(logPath)) return;

  let content = fs.readFileSync(logPath, 'utf-8');

  if (section && section !== 'FULL') {
    const start = content.indexOf(`========== ${section} SECTION START ==========`);
    const end = content.indexOf(`========== ${section} SECTION END ==========`);

    if (start !== -1 && end !== -1) {
      content = content.substring(start, end + `========== ${section} SECTION END ==========`.length);
    } else if (start !== -1) {
      content = content.substring(start);
    } else {
      content = `No ${section} section found in log`;
    }
  }

  panel.webview.postMessage({ command: 'updateLogContent', logPath, section, content });
}

async function handleOpenLog(runner: JobRunner, message: any, jobId: string): Promise<void> {
  const fs = require('fs');
  const { logPath, section, isRunning } = message;

  if (!fs.existsSync(logPath)) return;

  const doc = await vscode.workspace.openTextDocument(logPath);
  const editor = await vscode.window.showTextDocument(doc, {
    preview: false,
    viewColumn: vscode.ViewColumn.Beside
  });

  if (!editor) return;

  if (isRunning) {
    const lastLine = doc.lineCount - 1;
    const lastChar = doc.lineAt(lastLine).text.length;
    editor.selection = new vscode.Selection(lastLine, lastChar, lastLine, lastChar);
    editor.revealRange(new vscode.Range(lastLine, 0, lastLine, 0), vscode.TextEditorRevealType.InCenter);

    const refreshInterval = setInterval(async () => {
      const currentJob = runner.list().find(j => j.id === jobId);
      if (!currentJob || (currentJob.status !== 'running' && currentJob.status !== 'queued')) {
        clearInterval(refreshInterval);
        return;
      }

      if (!vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === logPath)) {
        clearInterval(refreshInterval);
        return;
      }

      try {
        await vscode.commands.executeCommand('workbench.action.files.revert');
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.uri.fsPath === logPath) {
          const doc = activeEditor.document;
          const newLastLine = doc.lineCount - 1;
          const newLastChar = doc.lineAt(newLastLine).text.length;
          activeEditor.selection = new vscode.Selection(newLastLine, newLastChar, newLastLine, newLastChar);
          activeEditor.revealRange(new vscode.Range(newLastLine, 0, newLastLine, 0), vscode.TextEditorRevealType.InCenter);
        }
      } catch {
        clearInterval(refreshInterval);
      }
    }, 2000);
  } else if (section) {
    const text = doc.getText();
    const sectionStart = text.indexOf(`========== ${section} SECTION START ==========`);
    if (sectionStart !== -1) {
      const startPos = doc.positionAt(sectionStart);
      editor.selection = new vscode.Selection(startPos, startPos);
      editor.revealRange(new vscode.Range(startPos, startPos), vscode.TextEditorRevealType.AtTop);
    }
  }
}

async function handleGetProcessStats(
  panel: vscode.WebviewPanel,
  runner: JobRunner,
  jobId: string,
  processMonitor: ProcessMonitor
): Promise<void> {
  const job = runner.list().find(j => j.id === jobId);
  if (!job?.processIds?.length) return;

  try {
    const snapshot = await processMonitor.getSnapshot();
    const stats = processMonitor.buildTree(job.processIds, snapshot);
    if (stats?.length) {
      panel.webview.postMessage({ command: 'updateProcessStats', stats });
    }
  } catch (error) {
    console.error('Failed to get process stats:', error);
  }
}

function setupAutoRefresh(
  panel: vscode.WebviewPanel,
  runner: JobRunner,
  jobId: string,
  jobDetailPanels: Map<string, vscode.WebviewPanel>
): void {
  let completionUpdates = 0;
  let lastJobStatus: string | undefined;
  let lastStepStatuses: string | undefined;

  const timer = setInterval(() => {
    const job = runner.list().find(j => j.id === jobId);

    if (!job) {
      clearInterval(timer);
      return;
    }

    if (job.status !== 'running' && job.status !== 'queued') {
      completionUpdates++;
      if (completionUpdates > 3) {
        clearInterval(timer);
        return;
      }
    }

    const panelRef = jobDetailPanels.get(jobId);
    if (panelRef) {
      // Check if we need a full re-render (status changed significantly)
      const currentStepStatuses = JSON.stringify(job.stepStatuses || {});
      const needsFullRender = lastJobStatus !== job.status || lastStepStatuses !== currentStepStatuses;
      
      if (needsFullRender) {
        // Full re-render only when status/steps change
        panelRef.webview.html = getJobDetailsHtml(job as any);
        lastJobStatus = job.status;
        lastStepStatuses = currentStepStatuses;
      }
      
      // Always send incremental updates for logs and process stats (handled by webview JS)
      // The webview JS handles log polling internally via message passing
    }
  }, 2000);

  panel.onDidDispose(() => clearInterval(timer));
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
