/**
 * @fileoverview Job-related VS Code commands.
 * 
 * Contains command handlers for job creation, management, and lifecycle operations.
 * All commands are designed to be testable with dependency injection.
 * 
 * @module commands/jobCommands
 */

import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { IJobRunner } from '../interfaces/IJobRunner';
import { detectWorkspace } from '../core/detector';
import { JobSpec } from '../types/job';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Dependencies required by job commands.
 * Enables dependency injection for testing.
 */
export interface JobCommandsDependencies {
  /** Job runner instance for managing job lifecycle */
  runner: IJobRunner;
  /** Callback to trigger UI refresh after operations */
  updateUI: () => void;
  /** Map of open job detail panels */
  jobDetailPanels: Map<string, vscode.WebviewPanel>;
  /** Function to generate job details HTML */
  getJobDetailsHtml: (job: any, webview: vscode.Webview) => string;
}

/**
 * Quick pick item for job selection.
 */
interface JobQuickPickItem extends vscode.QuickPickItem {
  jobId: string;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get the current workspace folder path.
 * 
 * @returns Workspace path or undefined if no workspace open
 */
function getWorkspacePath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Get Git branch information for a workspace.
 * 
 * @param workspacePath - Path to the workspace
 * @returns Object containing current and default branch names
 */
function getGitBranchInfo(workspacePath: string): { currentBranch: string; defaultBranch: string } {
  const { execSync } = require('child_process');
  let currentBranch = 'main';
  let defaultBranch = 'main';

  try {
    currentBranch = execSync('git branch --show-current', { 
      cwd: workspacePath, 
      encoding: 'utf-8' 
    }).trim();

    // Try to detect the default branch from remote HEAD
    try {
      const remoteHead = execSync('git symbolic-ref refs/remotes/origin/HEAD 2>nul', { 
        cwd: workspacePath, 
        encoding: 'utf-8' 
      }).trim();
      defaultBranch = remoteHead.replace('refs/remotes/origin/', '');
    } catch {
      // Fallback: check which common default branch exists
      const branches = execSync('git branch -r', { cwd: workspacePath, encoding: 'utf-8' });
      if (branches.includes('origin/main')) {
        defaultBranch = 'main';
      } else if (branches.includes('origin/master')) {
        defaultBranch = 'master';
      } else if (branches.includes('origin/develop')) {
        defaultBranch = 'develop';
      }
    }
  } catch (e) {
    console.error('Failed to get git branch info:', e);
  }

  return { currentBranch, defaultBranch };
}

/**
 * Load workspace configuration for orchestrator.
 * 
 * @param workspacePath - Path to the workspace
 * @returns Configuration object
 */
function loadWorkspaceConfig(workspacePath: string): { worktreeRoot: string } {
  const fs = require('fs');
  const path = require('path');
  const configPath = path.join(workspacePath, '.orchestrator', 'config.json');

  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      // Fall through to default
    }
  }

  return { worktreeRoot: '.worktrees' };
}

// ============================================================================
// COMMAND HANDLERS
// ============================================================================

/**
 * Register all job-related commands with VS Code.
 * 
 * @param context - Extension context for subscription management
 * @param deps - Command dependencies (runner, updateUI, panels, etc.)
 */
export function registerJobCommands(
  context: vscode.ExtensionContext,
  deps: JobCommandsDependencies
): void {
  const { runner, updateUI, jobDetailPanels, getJobDetailsHtml } = deps;

  // Start/Create Job
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.startJob', async () => {
      const ws = getWorkspacePath();
      if (!ws) {
        vscode.window.showErrorMessage('Open a workspace with a Git repo.');
        return;
      }

      const det = detectWorkspace(ws);
      const jobName = await vscode.window.showInputBox({
        prompt: 'Job name (for display)',
        value: `job-${Date.now()}`
      }) || `job-${Date.now()}`;

      const { currentBranch, defaultBranch } = getGitBranchInfo(ws);

      // Determine base and target branches automatically
      const isOnDefaultBranch = currentBranch === defaultBranch;
      let baseBranch = currentBranch;
      let targetBranch = currentBranch;

      if (isOnDefaultBranch) {
        // On default branch: create a new feature branch
        const friendlyName = jobName.replace(/\W+/g, '-').toLowerCase();
        targetBranch = `feature/${friendlyName}`;
        baseBranch = defaultBranch;
      }

      const jobId = randomUUID();
      const conf = loadWorkspaceConfig(ws);

      const spec: JobSpec = {
        id: jobId,
        name: jobName,
        task: 'generic-work',
        inputs: {
          repoPath: ws,
          baseBranch,
          targetBranch,
          worktreeRoot: conf.worktreeRoot || '.worktrees',
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
      };

      runner.enqueue(spec);
      vscode.window.showInformationMessage(
        `Job "${jobName}" queued on ${targetBranch} (ID: ${jobId.substring(0, 8)}...)`
      );
    })
  );

  // Create Job (alias)
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.createJob', async () => {
      vscode.commands.executeCommand('orchestrator.startJob');
    })
  );

  // Retry Job
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.retryJob', async (jobId?: string, updatedWorkContext?: string) => {
      if (!jobId) {
        const jobs = runner.list().filter(j => j.status === 'failed' || j.status === 'canceled');
        if (jobs.length === 0) {
          vscode.window.showInformationMessage('No failed or canceled jobs to retry');
          return;
        }

        const items: JobQuickPickItem[] = jobs.map(j => ({
          label: j.name,
          description: `${j.status} at ${j.currentStep || 'unknown step'} - ${j.id.substring(0, 8)}...`,
          jobId: j.id
        }));

        const pick = await vscode.window.showQuickPick(items, { 
          placeHolder: 'Select job to retry' 
        });
        if (!pick) return;
        jobId = pick.jobId;
      }

      const job = runner.list().find(j => j.id === jobId);
      if (!job || !jobId) return;

      const confirmedJobId = jobId;
      (runner as any).retry(confirmedJobId, updatedWorkContext);
      
      const contextMsg = updatedWorkContext ? ' with updated context' : ' with AI analysis';
      vscode.window.showInformationMessage(`Job "${job.name}" queued for retry${contextMsg}`);
      updateUI();

      // Refresh the job details panel if it's open for this job
      const panel = jobDetailPanels.get(confirmedJobId);
      if (panel) {
        const updatedJob = runner.list().find(j => j.id === confirmedJobId);
        if (updatedJob) {
          panel.webview.html = getJobDetailsHtml(updatedJob, panel.webview);
        }
      }
    })
  );

  // Cancel Job
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.cancelJob', async (jobId?: string) => {
      if (!jobId) {
        const items: JobQuickPickItem[] = runner.list()
          .filter(j => j.status === 'running' || j.status === 'queued')
          .map(j => ({
            label: j.name,
            description: `${j.status} - ${j.id.substring(0, 8)}...`,
            jobId: j.id
          }));

        if (items.length === 0) {
          vscode.window.showInformationMessage('No running or queued jobs to cancel');
          return;
        }

        const pick = await vscode.window.showQuickPick(items, { 
          placeHolder: 'Select a job to cancel' 
        });
        if (!pick) return;
        jobId = pick.jobId;
      }

      const job = runner.list().find(j => j.id === jobId);
      (runner as any).cancel(jobId);
      vscode.window.showWarningMessage(`Job "${job?.name || jobId}" canceled`);
      updateUI();
    })
  );

  // Delete Job
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.deleteJob', async (jobId?: string) => {
      if (!jobId) {
        const jobs = runner.list();
        const items: JobQuickPickItem[] = jobs.map(j => ({
          label: j.name,
          description: `${j.status} - ${j.id.substring(0, 8)}...`,
          jobId: j.id
        }));

        const pick = await vscode.window.showQuickPick(items, { 
          placeHolder: 'Select job to delete' 
        });
        if (!pick) return;
        jobId = pick.jobId;
      }

      const job = runner.list().find(j => j.id === jobId);
      if (!job) {
        vscode.window.showErrorMessage(`Job ${jobId} not found`);
        return;
      }

      const warningMsg = job.status === 'running'
        ? `Job "${job.name}" is currently running. It will be stopped and deleted. Continue?`
        : `Delete job "${job.name}"?`;

      const confirm = await vscode.window.showWarningMessage(
        warningMsg,
        { modal: true },
        'Delete'
      );

      if (confirm === 'Delete') {
        const success = (runner as any).delete(jobId);
        if (success) {
          vscode.window.showInformationMessage(`Job "${job.name}" deleted`);
          updateUI();
        } else {
          vscode.window.showErrorMessage(`Failed to delete job "${job.name}"`);
        }
      }
    })
  );

  // Open Job Worktree
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.openJobWorktree', async (jobId?: string) => {
      if (!jobId) {
        const jobs = runner.list();
        const items: JobQuickPickItem[] = jobs.map(j => ({
          label: j.name,
          description: `${j.status} - ${j.id.substring(0, 8)}...`,
          jobId: j.id
        }));

        const pick = await vscode.window.showQuickPick(items, { 
          placeHolder: 'Select job worktree to open' 
        });
        if (!pick) return;
        jobId = pick.jobId;
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
    })
  );

  // Merge Completed Job
  context.subscriptions.push(
    vscode.commands.registerCommand('orchestrator.mergeCompletedJob', async () => {
      const jobs = runner.list().filter(j => j.status === 'succeeded');
      if (!jobs.length) {
        vscode.window.showInformationMessage('No succeeded jobs to merge.');
        return;
      }

      const pick = await vscode.window.showQuickPick(
        jobs.map(j => ({
          label: j.id,
          description: j.inputs.targetBranch
        })),
        { placeHolder: 'Pick job to merge into base' }
      );

      if (!pick) return;
      vscode.window.showInformationMessage(
        `Job ${pick.label} already merged (or handled by auto-merge).`
      );
    })
  );
}
