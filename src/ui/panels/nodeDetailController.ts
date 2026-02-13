/**
 * @fileoverview Node Detail Controller
 *
 * Handles message processing for the node detail panel webview.
 * Extracts message handling logic from the panel into a testable
 * controller that takes service interfaces via constructor injection.
 *
 * @module ui/panels/nodeDetailController
 */

import type { IDialogService } from '../../interfaces/IDialogService';
import type { IClipboardService } from '../../interfaces/IClipboardService';

/**
 * Command actions that the controller delegates to the panel/host.
 */
export interface NodeDetailCommands {
  /** Execute a VS Code command */
  executeCommand(command: string, ...args: any[]): void;
  /** Open a folder in a new window */
  openFolder(path: string): void;
  /** Refresh the panel content */
  refresh(): void;
  /** Send log content for a phase */
  sendLog(phase: string): void;
  /** Send process stats */
  sendProcessStats(): void;
  /** Retry a node */
  retryNode(planId: string, nodeId: string, resumeSession: boolean): Promise<void>;
  /** Force fail a node */
  forceFailNode(planId: string, nodeId: string): Promise<void>;
  /** Open a file in the editor */
  openFile(path: string): void;
  /** Get the worktree path for the current node */
  getWorktreePath(): string | undefined;
}

/**
 * Controller for node detail panel message handling.
 *
 * Processes webview messages and delegates to injected services
 * and command interfaces, making the logic testable without VS Code.
 */
export class NodeDetailController {
  /**
   * @param _planId - The Plan ID.
   * @param _nodeId - The Node ID.
   * @param _dialogService - Dialog service for user prompts.
   * @param _clipboardService - Clipboard service for copy operations.
   * @param _commands - Command interface for panel operations.
   */
  constructor(
    private _planId: string,
    private _nodeId: string,
    private _dialogService: IDialogService,
    private _clipboardService: IClipboardService,
    private _commands: NodeDetailCommands
  ) {}

  /**
   * Handle an incoming message from the webview.
   *
   * @param message - The message object from the webview.
   */
  async handleMessage(message: any): Promise<void> {
    switch (message.type) {
      case 'openPlan':
        this._commands.executeCommand('orchestrator.showPlanDetails', message.planId);
        break;
      case 'openWorktree': {
        const worktreePath = this._commands.getWorktreePath();
        if (worktreePath) {
          this._commands.openFolder(worktreePath);
        }
        break;
      }
      case 'refresh':
        this._commands.refresh();
        break;
      case 'getLog':
        this._commands.sendLog(message.phase);
        break;
      case 'getProcessStats':
        this._commands.sendProcessStats();
        break;
      case 'copyToClipboard':
        if (message.text) {
          await this._clipboardService.writeText(message.text);
          await this._dialogService.showInfo('Copied to clipboard');
        }
        break;
      case 'retryNode':
        try {
          await this._commands.retryNode(message.planId, message.nodeId, message.resumeSession);
        } catch (err: any) {
          await this._dialogService.showError(`Retry failed: ${err?.message || err}`);
        }
        break;
      case 'confirmForceFailNode': {
        const choice = await this._dialogService.showWarning(
          'Force-fail this node? This will mark it as failed and may affect downstream nodes.',
          { modal: true },
          'Force Fail'
        );
        if (choice === 'Force Fail') {
          try {
            await this._commands.forceFailNode(
              message.planId || this._planId,
              message.nodeId || this._nodeId
            );
          } catch (err: any) {
            await this._dialogService.showError(`Force fail failed: ${err?.message || err}`);
          }
        }
        break;
      }
      case 'forceFailNode':
        try {
          await this._commands.forceFailNode(
            message.planId || this._planId,
            message.nodeId || this._nodeId
          );
        } catch (err: any) {
          await this._dialogService.showError(`Force fail failed: ${err?.message || err}`);
        }
        break;
      case 'openLogFile':
        if (message.path) {
          this._commands.openFile(message.path);
        }
        break;
    }
  }
}
