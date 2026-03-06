/**
 * @fileoverview Release Management Controller
 *
 * Handles webview message dispatching for the release management panel.
 * Decouples message handling from the VS Code panel lifecycle so that
 * the logic can be tested without the vscode module.
 *
 * @module ui/panels/releaseManagementController
 */

import type { IDialogService } from '../../interfaces/IDialogService';

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
 * const controller = new ReleaseManagementController(releaseId, dialogService, delegate);
 * panel.webview.onDidReceiveMessage(msg => controller.handleMessage(msg));
 * ```
 */
export class ReleaseManagementController {
  /**
   * @param _releaseId - The Release ID this controller manages.
   * @param _dialogService - Abstraction over VS Code dialog APIs.
   * @param _delegate - Delegate for VS Code operations.
   */
  constructor(
    private readonly _releaseId: string,
    private readonly _dialogService: IDialogService,
    private readonly _delegate: ReleaseManagementDelegate,
  ) {}

  /**
   * Handle an incoming webview message.
   *
   * @param message - The message object from `postMessage`.
   */
  public handleMessage(message: any): void {
    switch (message.type) {
      case 'startMerge':
        this._delegate.executeCommand('orchestrator.startReleaseMerge', this._releaseId);
        break;
      case 'startPrepare':
        this._delegate.executeCommand('orchestrator.startReleasePrepare', this._releaseId);
        break;
      case 'executeTask':
        if (message.taskId) {
          this._delegate.executeCommand('orchestrator.executeReleaseTask', this._releaseId, message.taskId);
        }
        break;
      case 'skipTask':
        if (message.taskId) {
          this._delegate.executeCommand('orchestrator.skipReleaseTask', this._releaseId, message.taskId);
        }
        break;
      case 'markTaskComplete':
        if (message.taskId) {
          this._delegate.executeCommand('orchestrator.markReleaseTaskComplete', this._releaseId, message.taskId);
        }
        break;
      case 'createPR':
        this._delegate.executeCommand('orchestrator.createReleasePR', this._releaseId);
        break;
      case 'adoptPR':
        if (message.prNumber) {
          this._delegate.executeCommand('orchestrator.adoptReleasePR', this._releaseId, message.prNumber);
        }
        break;
      case 'startMonitoring':
        this._delegate.executeCommand('orchestrator.startReleaseMonitoring', this._releaseId);
        break;
      case 'pauseMonitoring':
        this._delegate.executeCommand('orchestrator.pauseReleaseMonitoring', this._releaseId);
        break;
      case 'stopMonitoring':
        this._delegate.executeCommand('orchestrator.stopReleaseMonitoring', this._releaseId);
        break;
      case 'openPlanSelector':
        this._delegate.executeCommand('orchestrator.openReleasePlanSelector', this._releaseId);
        break;
      case 'cancelRelease':
        this._delegate.executeCommand('orchestrator.cancelRelease', this._releaseId);
        break;
      case 'addPlan':
        if (message.planId) {
          this._delegate.executeCommand('orchestrator.addPlanToRelease', this._releaseId, message.planId);
        }
        break;
      case 'removePlan':
        if (message.planId) {
          this._delegate.executeCommand('orchestrator.removePlanFromRelease', this._releaseId, message.planId);
        }
        break;
      case 'updateConfiguration':
        if (message.config) {
          this._delegate.executeCommand('orchestrator.updateReleaseConfig', this._releaseId, message.config);
        }
        break;
      case 'retryMerge':
        if (message.planId) {
          this._delegate.executeCommand('orchestrator.retryReleaseMerge', this._releaseId, message.planId);
        }
        break;
      case 'addressFeedback':
        if (message.feedbackId) {
          this._delegate.executeCommand('orchestrator.addressPRFeedback', this._releaseId, message.feedbackId);
        }
        break;
      case 'refresh':
        this._delegate.forceFullRefresh();
        break;
    }
  }
}
