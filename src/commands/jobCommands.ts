/**
 * @fileoverview Job Commands - VS Code command handlers for job operations.
 * 
 * Single responsibility: Register and handle all job-related VS Code commands.
 * 
 * Commands:
 * - orchestrator.startJob - Create a new job
 * - orchestrator.createJob - Alias for startJob
 * - orchestrator.retryJob - Retry a failed/canceled job
 * - orchestrator.cancelJob - Cancel a running/queued job
 * - orchestrator.deleteJob - Delete a job
 * - orchestrator.openJobWorktree - Open job's worktree
 * - orchestrator.mergeCompletedJob - Merge a completed job
 * - orchestrator.showJobDetails - Show job details panel
 * - orchestrator.showJobSection - Navigate to job section
 * 
 * @module commands/jobCommands
 */

import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { JobRunner, Job } from '../core/jobRunner';
import { ProcessMonitor } from '../process/processMonitor';
import { detectWorkspace } from '../core/detector';
import { getJobDetailsHtml, getJobDetailsLoadingHtml } from '../ui/templates/jobDetailsHtml';
import * as git from '../git';
import { Logger, ComponentLogger } from '../core/logger';

/** Component logger */
const log: ComponentLogger = Logger.for('jobs');

/**
 * Job command dependencies.
 */
export interface JobCommandDependencies {
  runner: JobRunner;
  processMonitor: ProcessMonitor;
  jobDetailPanels: Map<string, vscode.WebviewPanel>;
  worktreeRoot: string;
  updateUI: () => void;
}

/**
 * Register all job-related commands.
 * 
 * @param context - Extension context for subscriptions
 * @param deps - Command dependencies
 */
export function registerJobCommands(
  context: vscode.ExtensionContext,
  deps: JobCommandDependencies
): void {
  const { runner, processMonitor, jobDetailPanels, worktreeRoot, updateUI } = deps;

  log.info('Registering job commands');

  // Start Job
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.startJob', async () => {
      await handleStartJob(runner, worktreeRoot);
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

  log.info('Job commands registered');
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

  let currentBranch = 'main';
  let isOnDefaultBranch = false;

  try {
    currentBranch = await git.branches.currentOrNull(ws) || 'main';
    isOnDefaultBranch = await git.branches.isDefaultBranch(currentBranch, ws);
  } catch (e) {
    log.error('Failed to get git branch info', { error: e });
  }

  let baseBranch = currentBranch;
  let targetBranch = currentBranch;

  if (isOnDefaultBranch) {
    const friendlyName = jobName.replace(/\W+/g, '-').toLowerCase();
    targetBranch = `feature/${friendlyName}`;
    baseBranch = currentBranch;
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

  log.info(`Job "${jobName}" queued`, { jobId, targetBranch });
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
  log.info(`Job "${job.name}" queued for retry`, { jobId, hasContext: !!updatedWorkContext });
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
  log.info(`Job "${job?.name || jobId}" canceled`, { jobId });
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
      log.info(`Job "${job.name}" deleted`, { jobId });
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

  if (!jobId) return;

  // Check if panel already exists - reveal immediately
  const existingPanel = jobDetailPanels.get(jobId);
  if (existingPanel) {
    existingPanel.reveal(vscode.ViewColumn.Active);
    existingPanel.webview.html = getJobDetailsLoadingHtml('Refreshing...');
    const existingJobId = jobId;
    setImmediate(() => {
      const job = runner.list().find(j => j.id === existingJobId);
      if (job) {
        existingPanel.webview.html = getJobDetailsHtml(job as any);
      }
    });
    return;
  }

  // Create new panel with loading state
  const panel = vscode.window.createWebviewPanel(
    'jobDetails',
    `Job: Loading...`,
    vscode.ViewColumn.Active,
    { enableScripts: true, enableCommandUris: true }
  );

  panel.webview.html = getJobDetailsLoadingHtml();

  const currentJobId = jobId;
  jobDetailPanels.set(currentJobId, panel);

  panel.onDidDispose(() => {
    jobDetailPanels.delete(currentJobId);
  });

  setImmediate(() => {
    const job = runner.list().find(j => j.id === currentJobId);
    if (!job) {
      panel.webview.html = `<html><body style="padding:20px;font-family:sans-serif;color:#cc0000;"><h2>❌ Job not found</h2><p>Job ${currentJobId} could not be located.</p></body></html>`;
      return;
    }

    panel.title = `Job: ${job.name}`;
    (panel as any)._lastStatus = job.status;

    setupJobDetailMessageHandler(panel, runner, currentJobId, jobDetailPanels, processMonitor);
    panel.webview.html = getJobDetailsHtml(job as any);

    if (job.status === 'running' || job.status === 'queued') {
      setupAutoRefresh(panel, runner, currentJobId, jobDetailPanels);
    }
  });
}

// ============================================================================
// WEBVIEW MESSAGE HANDLING
// ============================================================================

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
    log.error('Failed to get process stats', { error, jobId });
  }
}

// ============================================================================
// AUTO-REFRESH
// ============================================================================

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
      const currentStepStatuses = JSON.stringify(job.stepStatuses || {});
      const needsFullRender = lastJobStatus !== job.status || lastStepStatuses !== currentStepStatuses;
      
      if (needsFullRender) {
        panelRef.webview.html = getJobDetailsHtml(job as any);
        lastJobStatus = job.status;
        lastStepStatuses = currentStepStatuses;
      }
    }
  }, 2000);

  panel.onDidDispose(() => clearInterval(timer));
}
