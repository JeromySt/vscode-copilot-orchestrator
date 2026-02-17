/**
 * @fileoverview Plan Detail Controller
 *
 * Handles webview message dispatching for the plan detail panel.
 * Decouples message handling from the VS Code panel lifecycle so that
 * the logic can be tested without the vscode module.
 *
 * @module ui/panels/planDetailController
 */

import type { IDialogService } from '../../interfaces/IDialogService';

/**
 * Delegate interface for VS Code operations that the controller cannot
 * perform directly (command execution, webview posting, etc.).
 */
export interface PlanDetailDelegate {
  /** Execute a VS Code command by ID. */
  executeCommand(command: string, ...args: any[]): Promise<void>;
  /** Post a message to the webview. */
  postMessage(message: any): void;
  /** Force a full HTML refresh of the panel. */
  forceFullRefresh(): void;
  /** Show the work summary document. */
  showWorkSummaryDocument(): void;
  /** Send all process stats to the webview. */
  sendAllProcessStats(): void;
  /** Open a file in the editor by relative path. */
  openFile(relativePath: string): void;
}

/**
 * Controller that processes messages from the plan detail webview.
 *
 * Extracts message handling from `planDetailPanel` so that the panel
 * class remains a thin VS Code adapter.
 *
 * @example
 * ```ts
 * const controller = new PlanDetailController(planId, dialogService, delegate);
 * panel.webview.onDidReceiveMessage(msg => controller.handleMessage(msg));
 * ```
 */
export class PlanDetailController {
  /**
   * @param _planId - The Plan ID this controller manages.
   * @param _dialogService - Abstraction over VS Code dialog APIs.
   * @param _delegate - Delegate for VS Code operations.
   */
  constructor(
    private readonly _planId: string,
    private readonly _dialogService: IDialogService,
    private readonly _delegate: PlanDetailDelegate,
  ) {}

  /**
   * Handle an incoming webview message.
   *
   * @param message - The message object from `postMessage`.
   */
  public handleMessage(message: any): void {
    switch (message.type) {
      case 'cancel':
        this._delegate.executeCommand('orchestrator.cancelPlan', this._planId);
        break;
      case 'pause':
        this._delegate.executeCommand('orchestrator.pausePlan', this._planId).then(() => {
          setTimeout(() => this._delegate.forceFullRefresh(), 100);
        });
        break;
      case 'resume':
        this._delegate.executeCommand('orchestrator.resumePlan', this._planId).then(() => {
          setTimeout(() => this._delegate.forceFullRefresh(), 100);
        });
        break;
      case 'delete':
        this._delegate.executeCommand('orchestrator.deletePlan', this._planId);
        break;
      case 'openNode': {
        const planIdForNode = message.planId || this._planId;
        this._delegate.executeCommand('orchestrator.showNodeDetails', planIdForNode, message.nodeId);
        break;
      }
      case 'refresh':
        this._delegate.forceFullRefresh();
        break;
      case 'showWorkSummary':
        this._delegate.showWorkSummaryDocument();
        break;
      case 'getAllProcessStats':
        this._delegate.sendAllProcessStats();
        break;
      case 'openFile':
        if (message.path) {
          this._delegate.openFile(message.path);
        }
        break;
    }
  }
}
