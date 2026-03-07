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
  ) {
    // Subscribe to release state changes
    this._releaseManager.on('releaseStatusChanged', (release) => {
      if (release.id === this._releaseId) {
        this._onStateChanged(release.status);
      }
    });

    // Subscribe to release progress updates (includes task changes)
    this._releaseManager.on('releaseProgress', (releaseId) => {
      if (releaseId === this._releaseId) {
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
      case 'addPlans':
        if (message.planIds && Array.isArray(message.planIds)) {
          this._releaseManager.addPlansToRelease(this._releaseId, message.planIds).catch((error) => {
            this._dialogService.showError(`Failed to add plans: ${error.message}`);
          });
        }
        break;
      case 'createPR':
        this._releaseManager.createPR(this._releaseId, message.asDraft).catch((error) => {
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
