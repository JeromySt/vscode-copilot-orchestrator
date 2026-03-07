/**
 * @fileoverview Active PR Controller
 *
 * Handles webview message dispatching for the active PR panel.
 * Decouples message handling from the VS Code panel lifecycle so that
 * the logic can be tested without the vscode module.
 *
 * @module ui/panels/activePRController
 */

import type { IDialogService } from '../../interfaces/IDialogService';

/**
 * Delegate interface for VS Code operations that the controller cannot
 * perform directly (command execution, webview posting, etc.).
 */
export interface ActivePRDelegate {
  /** Execute a VS Code command by ID. */
  executeCommand(command: string, ...args: any[]): Promise<void>;
  /** Post a message to the webview. */
  postMessage(message: any): void;
  /** Force a full HTML refresh of the panel. */
  forceFullRefresh(): void;
}

/**
 * Controller that processes messages from the active PR webview.
 *
 * Extracts message handling from `activePRPanel` so that the panel
 * class remains a thin VS Code adapter.
 *
 * @example
 * ```ts
 * const controller = new ActivePRController(managedPRId, dialogService, delegate);
 * panel.webview.onDidReceiveMessage(msg => controller.handleMessage(msg));
 * ```
 */
export class ActivePRController {
  /**
   * @param _managedPRId - The Managed PR ID this controller manages.
   * @param _dialogService - Abstraction over VS Code dialog APIs.
   * @param _delegate - Delegate for VS Code operations.
   */
  constructor(
    private readonly _managedPRId: string,
    private readonly _dialogService: IDialogService,
    private readonly _delegate: ActivePRDelegate,
  ) {}

  /**
   * Handle an incoming webview message.
   *
   * @param message - The message object from `postMessage`.
   */
  public async handleMessage(message: any): Promise<void> {
    switch (message.type) {
      case 'monitor':
        await this._delegate.executeCommand('orchestrator.monitorPR', this._managedPRId);
        setTimeout(() => this._delegate.forceFullRefresh(), 100);
        break;

      case 'pause':
        await this._delegate.executeCommand('orchestrator.pausePR', this._managedPRId);
        setTimeout(() => this._delegate.forceFullRefresh(), 100);
        break;

      case 'promote': {
        const confirmed = await this._dialogService.showWarning(
          'Promote this PR to ready for review?',
          { modal: true },
          'Promote',
          'Cancel'
        );
        if (confirmed === 'Promote') {
          await this._delegate.executeCommand('orchestrator.promotePR', this._managedPRId);
          setTimeout(() => this._delegate.forceFullRefresh(), 100);
        }
        break;
      }

      case 'demote': {
        const confirmed = await this._dialogService.showWarning(
          'Convert this PR to draft?',
          { modal: true },
          'Convert to Draft',
          'Cancel'
        );
        if (confirmed === 'Convert to Draft') {
          await this._delegate.executeCommand('orchestrator.demotePR', this._managedPRId);
          setTimeout(() => this._delegate.forceFullRefresh(), 100);
        }
        break;
      }

      case 'abandon': {
        const confirmed = await this._dialogService.showWarning(
          'Stop managing this PR? The PR will remain on the remote but will no longer be monitored.',
          { modal: true },
          'Abandon',
          'Cancel'
        );
        if (confirmed === 'Abandon') {
          await this._delegate.executeCommand('orchestrator.abandonPR', this._managedPRId);
        }
        break;
      }

      case 'remove': {
        const confirmed = await this._dialogService.showWarning(
          'Permanently remove this PR from management? This cannot be undone.',
          { modal: true },
          'Remove',
          'Cancel'
        );
        if (confirmed === 'Remove') {
          await this._delegate.executeCommand('orchestrator.removePR', this._managedPRId);
        }
        break;
      }

      case 'refresh':
        this._delegate.forceFullRefresh();
        break;

      case 'openPR':
        if (message.url) {
          await this._delegate.executeCommand('vscode.open', message.url);
        }
        break;
    }
  }
}
