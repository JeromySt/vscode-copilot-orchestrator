/**
 * @fileoverview Release Management Controller
 *
 * Handles webview message dispatching for the release management panel.
 * Decouples message handling from the VS Code panel lifecycle so that
 * the logic can be tested without the vscode module.
 *
 * @module ui/panels/releaseManagementController
 */

import * as vscode from 'vscode';
import type { IDialogService } from '../../interfaces/IDialogService';
import type { IReleaseManager } from '../../interfaces/IReleaseManager';
import type { ReleaseStatus } from '../../plan/types/release';

/**
 * Delegate interface for VS Code operations that the controller cannot
 * perform directly (command execution, webview posting, etc.).
 */
export interface ReleaseManagementDelegate {
  /** Execute a VS Code command by ID. */
  executeCommand(command: string, ...args: any[]): Promise<void>;
  /** Post a message to the webview. */
  postMessage(message: any): void;
  /** Force a full HTML refresh of the panel. */
  forceFullRefresh(): void;
  /** Close and dispose the panel. */
  closePanel(): void;
  /** Read a VS Code configuration value. */
  getConfig<T>(section: string, key: string, defaultValue: T): T;
}

/**
 * Controller that processes messages from the release management webview.
 *
 * Extracts message handling from `releaseManagementPanel` so that the panel
 * class remains a thin VS Code adapter.
 *
 * @example
 * ```ts
 * const controller = new ReleaseManagementController(releaseId, dialogService, delegate, releaseManager);
 * panel.webview.onDidReceiveMessage(msg => controller.handleMessage(msg));
 * ```
 */
export class ReleaseManagementController {
  /**
   * @param _releaseId - The Release ID this controller manages.
   * @param _dialogService - Abstraction over VS Code dialog APIs.
   * @param _delegate - Delegate for VS Code operations.
   * @param _releaseManager - Release manager for state transitions and operations.
   */
  constructor(
    private readonly _releaseId: string,
    private readonly _dialogService: IDialogService,
    private readonly _delegate: ReleaseManagementDelegate,
    private readonly _releaseManager: IReleaseManager,
    private readonly _planRunner?: { get(id: string): any },
  ) {
    // Subscribe to release state changes
    this._releaseManager.on('releaseStatusChanged', (release) => {
      if (release.id === this._releaseId) {
        this._onStateChanged(release.status);
      }
    });

    // Subscribe to release progress updates (includes task changes)
    // Only full-refresh for non-monitoring states — monitoring uses incremental messages.
    this._releaseManager.on('releaseProgress', (releaseId) => {
      if (releaseId === this._releaseId) {
        const release = this._releaseManager.getRelease(this._releaseId);
        const status = release?.status;
        if (status === 'monitoring' || status === 'addressing' || status === 'pr-active') {
          return;
        }
        this._delegate.forceFullRefresh();
      }
    });
  }

  /**
   * Handle an incoming webview message.
   *
   * @param message - The message object from `postMessage`.
   */
  public handleMessage(message: any): void {
    switch (message.type) {
      case 'prepareRelease':
        this._releaseManager.transitionToState(this._releaseId, 'preparing', 'User initiated preparation').catch((error) => {
          this._dialogService.showError(`Failed to transition to preparing: ${error.message}`);
        });
        break;
      case 'executeTask':
        if (message.taskId) {
          this._releaseManager.executePreparationTask(this._releaseId, message.taskId).catch((error) => {
            this._dialogService.showError(`Failed to execute task: ${error.message}`);
          });
        }
        break;
      case 'completeTask':
        if (message.taskId) {
          this._releaseManager.completePreparationTask(this._releaseId, message.taskId).catch((error) => {
            this._dialogService.showError(`Failed to complete task: ${error.message}`);
          });
        }
        break;
      case 'skipTask':
        if (message.taskId) {
          this._releaseManager.skipPreparationTask(this._releaseId, message.taskId).catch((error) => {
            this._dialogService.showError(`Failed to skip task: ${error.message}`);
          });
        }
        break;
      case 'retryTask':
        if (message.taskId) {
          // Reset the failed task to pending, then re-execute
          const retryRelease = this._releaseManager.getRelease(this._releaseId);
          if (retryRelease) {
            const task = retryRelease.prepTasks?.find((t: any) => t.id === message.taskId);
            if (task) {
              task.status = 'pending';
              task.error = undefined;
              task.completedAt = undefined;
              this._delegate.forceFullRefresh();
              this._releaseManager.executePreparationTask(this._releaseId, message.taskId).catch((error) => {
                this._dialogService.showError(`Failed to retry task: ${error.message}`);
              });
            }
          }
        }
        break;
      case 'addPlans':
        if (message.planIds && Array.isArray(message.planIds)) {
          this._releaseManager.addPlansToRelease(this._releaseId, message.planIds).catch((error) => {
            this._dialogService.showError(`Failed to add plans: ${error.message}`);
          });
        }
        break;
      case 'createPR':
        // Transition to ready-for-pr first if still in preparing
        this._releaseManager.transitionToState(this._releaseId, 'ready-for-pr', 'All tasks complete, creating PR').then(() => {
          const asDraft = this._delegate.getConfig<boolean>('releaseManagement', 'createPRAsDraft', false);
          return this._releaseManager.createPR(this._releaseId, asDraft);
        }).catch((error) => {
          this._dialogService.showError(`Failed to create PR: ${error.message}`);
        });
        break;
      case 'adoptPR':
        if (message.prNumber) {
          this._releaseManager.adoptPR(this._releaseId, message.prNumber).catch((error) => {
            this._dialogService.showError(`Failed to adopt PR: ${error.message}`);
          });
        }
        break;
      case 'startMonitoring':
        this._releaseManager.startMonitoring(this._releaseId).catch((error) => {
          this._dialogService.showError(`Failed to start monitoring: ${error.message}`);
        });
        break;
      case 'stopMonitoring':
        this._releaseManager.stopMonitoring(this._releaseId).catch((error) => {
          this._dialogService.showError(`Failed to stop monitoring: ${error.message}`);
        });
        break;
      case 'goBack':
        this._handleGoBack();
        break;
      case 'startMerge':
        this._releaseManager.transitionToState(this._releaseId, 'merging', 'User started merge').catch((error) => {
          this._dialogService.showError(`Failed to start merge: ${error.message}`);
        });
        break;
      case 'startPrepare':
        this._releaseManager.transitionToState(this._releaseId, 'preparing', 'User started preparation').catch((error) => {
          this._dialogService.showError(`Failed to start preparation: ${error.message}`);
        });
        break;
      case 'markTaskComplete':
        if (message.taskId) {
          this._releaseManager.completePreparationTask(this._releaseId, message.taskId).catch((error) => {
            this._dialogService.showError(`Failed to complete task: ${error.message}`);
          });
        }
        break;
      case 'openPlanSelector':
        this._delegate.executeCommand('orchestrator.openReleasePlanSelector', this._releaseId);
        break;
      case 'cancelRelease':
        this._dialogService.showWarning(
          'Are you sure you want to cancel this release?',
          { modal: true },
          'Cancel Release',
        ).then((choice) => {
          if (choice !== 'Cancel Release') { return; }
          return this._releaseManager.transitionToState(this._releaseId, 'canceled', 'User canceled release').then((success) => {
            if (!success) {
              // Force-cancel: directly update the release status even if state machine rejects
              const rel = this._releaseManager.getRelease(this._releaseId);
              if (rel) {
                (rel as any).status = 'canceled';
              }
            }
            this._delegate.forceFullRefresh();
          });
        }).catch((error) => {
          this._dialogService.showError(`Failed to cancel release: ${error.message}`);
        });
        break;
      case 'scaffoldTasks':
        this._delegate.executeCommand('orchestrator.scaffoldReleaseTasks').catch((error) => {
          this._dialogService.showError(`Failed to scaffold tasks: ${error.message}`);
        });
        break;
      case 'deleteRelease':
        this._dialogService.showWarning(
          'Delete this release? This cannot be undone.',
          { modal: true },
          'Delete',
        ).then((choice) => {
          if (choice !== 'Delete') { return; }
          this._releaseManager.deleteRelease(this._releaseId);
          // Close the panel
          this._delegate.closePanel();
        }).catch((error) => {
          this._dialogService.showError(`Failed to delete release: ${error.message}`);
        });
        break;
      case 'retryRelease':
        // Reset failed release back to preparing so user can retry
        this._releaseManager.transitionToState(this._releaseId, 'preparing', 'Retrying after failure').then((success) => {
          if (!success) {
            // Force reset if state machine rejects
            const rel = this._releaseManager.getRelease(this._releaseId);
            if (rel) {
              (rel as any).status = 'preparing';
              (rel as any).error = undefined;
            }
          }
          this._delegate.forceFullRefresh();
        }).catch((error) => {
          this._dialogService.showError(`Failed to retry release: ${error.message}`);
        });
        break;
      case 'addPlan':
        if (message.planId) {
          this._releaseManager.addPlansToRelease(this._releaseId, [message.planId]).catch((error) => {
            this._dialogService.showError(`Failed to add plan: ${error.message}`);
          });
        }
        break;
      case 'removePlan':
        if (message.planId) {
          // Remove plan from release's planIds
          const release = this._releaseManager.getRelease(this._releaseId);
          if (release) {
            const updatedPlanIds = release.planIds.filter((id: string) => id !== message.planId);
            release.planIds = updatedPlanIds;
            this._delegate.forceFullRefresh();
          }
        }
        break;
      case 'updateConfiguration':
        if (message.config) {
          const rel = this._releaseManager.getRelease(this._releaseId);
          if (rel) {
            if (message.config.name) rel.name = message.config.name;
            if (message.config.targetBranch) rel.targetBranch = message.config.targetBranch;
            this._delegate.forceFullRefresh();
          }
        }
        break;
      case 'retryMerge':
        // Re-attempt merge for a specific plan
        this._delegate.forceFullRefresh();
        break;
      case 'addressFeedback':
        // Trigger Copilot to address specific feedback
        this._delegate.forceFullRefresh();
        break;
      case 'openPRComment': {
        // Open a file at the specified line with the PR comment shown as a decoration
        const release = this._releaseManager.getRelease(this._releaseId);
        if (release && message.filePath) {
          const repoPath = release.repoPath || '';
          const path = require('path');
          const fullPath = path.isAbsolute(message.filePath)
            ? message.filePath
            : path.join(repoPath, message.filePath);
          const uri = vscode.Uri.file(fullPath);
          const line = Math.max(1, message.line || 1);
          const selection = new vscode.Range(line - 1, 0, line - 1, 0);
          this._delegate.executeCommand('vscode.open', uri, { selection }).then(() => {
            // After opening the file, show the PR comment as a diagnostic / decoration
            this._delegate.executeCommand(
              'orchestrator.showPRCommentDecoration',
              fullPath,
              line,
              message.author || 'Reviewer',
              message.body || '',
              message.source || 'human',
            ).catch(() => { /* command may not exist yet */ });
          }).catch((error) => {
            this._dialogService.showError(`Failed to open file: ${error.message}`);
          });
        }
        break;
      }
      case 'openExternal':
        if (message.url) {
          this._delegate.executeCommand('vscode.open', vscode.Uri.parse(message.url)).catch((error) => {
            this._dialogService.showError(`Failed to open URL: ${error.message}`);
          });
        }
        break;
      case 'addressWithAI': {
        // Send selected findings to the release manager for AI-assisted fixing
        if (message.findings && Array.isArray(message.findings)) {
          this._releaseManager.addressFindings(this._releaseId, message.findings).catch((error) => {
            this._dialogService.showError(`Failed to address findings: ${error.message}`);
          });
        }
        break;
      }
      case 'toggleAutoFix':
        this._releaseManager.setAutoFix(this._releaseId, !!message.enabled);
        break;
      case 'openPlanDetail':
        if (message.planId) {
          this._delegate.executeCommand('orchestrator.showPlanDetails', message.planId).catch(() => {});
        }
        break;
      case 'openNodeDetail':
        if (message.planId && message.producerId) {
          const fixPlan = this._planRunner?.get(message.planId);
          const nid = fixPlan?.producerIdToNodeId?.get(message.producerId);
          if (nid) {
            this._delegate.executeCommand('orchestrator.showNodeDetails', message.planId, nid).catch(() => {});
          } else {
            this._delegate.executeCommand('orchestrator.showPlanDetails', message.planId).catch(() => {});
          }
        }
        break;
      case 'checkMergeReadiness':
        this._releaseManager.getMergeReadiness(this._releaseId).then((details) => {
          this._delegate.postMessage({ type: 'mergeReadiness', details });
        }).catch((error) => {
          this._delegate.postMessage({ type: 'mergeReadiness', details: null, error: error.message });
        });
        break;
      case 'mergePR': {
        const method = message.method || 'squash';
        const admin = !!message.admin;
        this._releaseManager.mergePR(this._releaseId, { method, admin }).then(() => {
          this._dialogService.showInfo('PR merged successfully!');
          this._delegate.forceFullRefresh();
        }).catch((error) => {
          this._dialogService.showError(`Failed to merge PR: ${error.message}`);
        });
        break;
      }
      case 'tagRelease': {
        const tagName = message.tagName;
        this._releaseManager.tagRelease(this._releaseId, tagName).then((tag) => {
          this._dialogService.showInfo(`Release tagged as ${tag}`);
        }).catch((error) => {
          this._dialogService.showError(`Failed to tag release: ${error.message}`);
        });
        break;
      }
      case 'refresh':
        this._delegate.forceFullRefresh();
        break;
      case 'viewTaskLog':
        if (message.taskId) {
          const logPath = this._releaseManager.getTaskLogFilePath(this._releaseId, message.taskId);
          if (logPath) {
            this._delegate.executeCommand('vscode.open', vscode.Uri.file(logPath)).catch((error) => {
              this._dialogService.showError(`Failed to open log file: ${error.message}`);
            });
          } else {
            this._dialogService.showInfo('No log available for this task');
          }
        }
        break;
      case 'updateFinding':
        if (message.taskId && message.findingId && message.status) {
          this._releaseManager.updateFindingStatus(this._releaseId, message.taskId, message.findingId, message.status).then(() => {
            this._delegate.forceFullRefresh();
          }).catch((error) => {
            this._dialogService.showError(`Failed to update finding: ${error.message}`);
          });
        }
        break;
      case 'openFindingFile':
        if (message.filePath) {
          const release = this._releaseManager.getRelease(this._releaseId);
          if (release && release.repoPath) {
            const fullPath = require('path').join(release.repoPath, message.filePath);
            const uri = vscode.Uri.file(fullPath);
            const line = message.line || 1;
            const selection = new vscode.Range(line - 1, 0, line - 1, 0);
            this._delegate.executeCommand('vscode.open', uri, { selection }).catch((error) => {
              this._dialogService.showError(`Failed to open file: ${error.message}`);
            });
          }
        }
        break;
      case 'getGitAccount':
        this._fetchGitAccount().catch((error) => {
          this._delegate.postMessage({ type: 'gitAccount', username: null });
        });
        break;
      case 'switchAccount':
        this._delegate.executeCommand('orchestrator.selectGitAccount').then(() => {
          // Refresh account display after selection
          this._fetchGitAccount().catch((error) => {
            this._delegate.postMessage({ type: 'gitAccount', username: null });
          });
        }).catch((error) => {
          this._dialogService.showError(`Failed to switch account: ${error.message}`);
        });
        break;
    }
  }

  /**
   * Fetch the currently configured git account for the release's repository.
   */
  private async _fetchGitAccount(): Promise<void> {
    const release = this._releaseManager.getRelease(this._releaseId);
    if (!release || !release.repoPath) {
      this._delegate.postMessage({ type: 'gitAccount', username: null });
      return;
    }

    try {
      // We need to spawn git to get the configured username
      // Since we don't have access to IProcessSpawner here, we'll use child_process directly
      const { spawn } = require('child_process');
      
      // Detect provider to get hostname
      const proc = spawn('git', ['remote', 'get-url', 'origin'], {
        cwd: release.repoPath,
        shell: false,
      });

      let remoteUrl = '';
      proc.stdout.on('data', (chunk: Buffer) => { remoteUrl += chunk.toString(); });

      proc.on('close', async () => {
        const url = remoteUrl.trim();
        const hostname = url.includes('github.com') ? 'github.com' : 
                        url.includes('dev.azure.com') ? 'dev.azure.com' :
                        'github.com'; // default

        // Get configured username
        const configProc = spawn('git', ['config', '--local', `credential.https://${hostname}.username`], {
          cwd: release.repoPath,
          shell: false,
        });

        let username = '';
        configProc.stdout.on('data', (chunk: Buffer) => { username += chunk.toString(); });

        configProc.on('close', () => {
          this._delegate.postMessage({ 
            type: 'gitAccount', 
            username: username.trim() || null 
          });
        });
      });
    } catch (error) {
      this._delegate.postMessage({ type: 'gitAccount', username: null });
    }
  }

  /**
   * Map release status to wizard step.
   */
  private _getStepForState(status: ReleaseStatus): string {
    switch (status) {
      case 'drafting':
        return 'configure';
      case 'preparing':
        return 'prepare';
      case 'merging':
        return 'merge';
      case 'ready-for-pr':
      case 'creating-pr':
        return 'pr';
      case 'pr-active':
      case 'monitoring':
      case 'addressing':
        return 'monitor';
      case 'succeeded':
        return 'complete';
      default:
        return 'configure';
    }
  }

  /**
   * Handle state change event from release manager.
   */
  private _onStateChanged(newStatus: ReleaseStatus): void {
    const step = this._getStepForState(newStatus);
    
    // Post step change message to webview
    this._delegate.postMessage({
      type: 'stepChanged',
      step,
      status: newStatus,
    });

    // Also trigger a full refresh to update UI
    this._delegate.forceFullRefresh();
  }

  /**
   * Handle "go back" navigation request.
   */
  private _handleGoBack(): void {
    const release = this._releaseManager.getRelease(this._releaseId);
    if (!release) {
      return;
    }

    let targetStatus: ReleaseStatus | null = null;

    // Determine previous step based on current status
    switch (release.status) {
      case 'preparing':
        targetStatus = 'drafting';
        break;
      case 'merging':
      case 'ready-for-pr':
        targetStatus = 'preparing';
        break;
      case 'creating-pr':
      case 'pr-active':
        targetStatus = 'ready-for-pr';
        break;
      case 'monitoring':
      case 'addressing':
        targetStatus = 'pr-active';
        break;
    }

    if (targetStatus) {
      this._releaseManager.transitionToState(this._releaseId, targetStatus, 'User navigated back').catch((error) => {
        this._dialogService.showError(`Failed to go back: ${error.message}`);
      });
    }
  }
}
