/**
 * @fileoverview Release Management Panel
 * 
 * Shows detailed view of a Release with:
 * - 5-step wizard: Select Plans → Configure → Merge → Monitor → Complete
 * - Plan selection checkboxes
 * - Merge progress visualization
 * - PR monitoring dashboard with checks, comments, security alerts
 * - Action log showing autonomous feedback resolution
 * 
 * @module ui/panels/releaseManagementPanel
 */

import * as vscode from 'vscode';
import { escapeHtml, errorPageHtml } from '../templates';
import { ReleaseManagementController } from './releaseManagementController';
import type { ReleaseManagementDelegate } from './releaseManagementController';
import type { IDialogService } from '../../interfaces/IDialogService';
import type { IReleaseManager } from '../../interfaces/IReleaseManager';
import type { IPulseEmitter, Disposable as PulseDisposable } from '../../interfaces/IPulseEmitter';
import { webviewScriptTag } from '../webviewUri';
import type { ReleaseDefinition } from '../../plan/types/release';

/**
 * Webview panel that shows a detailed view of a single Release's lifecycle.
 *
 * Displays a 5-step wizard for release configuration, plan selection,
 * merge progress, PR monitoring, and completion. Updates in real-time
 * as the release progresses through its lifecycle.
 *
 * Only one panel is created per Release ID — subsequent calls to
 * {@link createOrShow} reveal the existing panel.
 *
 * **Webview → Extension messages:**
 * - `{ type: 'startRelease' }` — start the release process
 * - `{ type: 'cancelRelease' }` — cancel the release
 * - `{ type: 'addPlan', planId: string }` — add a plan to the release
 * - `{ type: 'removePlan', planId: string }` — remove a plan from the release
 * - `{ type: 'updateConfiguration', config: any }` — update release configuration
 * - `{ type: 'retryMerge', planId: string }` — retry merging a specific plan
 * - `{ type: 'addressFeedback', feedbackId: string }` — address specific PR feedback
 * - `{ type: 'refresh' }` — request a manual data refresh
 *
 * **Extension → Webview messages:**
 * - Full HTML re-render via `webview.html` on each update cycle
 * - `{ type: 'pulse' }` — periodic pulse for client-side timers
 */
export class ReleaseManagementPanel {
  private static panels = new Map<string, ReleaseManagementPanel>();
  
  private readonly _panel: vscode.WebviewPanel;
  private _releaseId: string;
  private _disposables: vscode.Disposable[] = [];
  private _pulseSubscription?: PulseDisposable;
  private readonly _controller: ReleaseManagementController;
  private _disposed = false;
  
  /**
   * @param panel - The VS Code webview panel instance.
   * @param releaseId - Unique identifier of the Release to display.
   * @param _getReleaseData - Function to fetch release data.
   * @param dialogService - Abstraction over VS Code dialog APIs.
   * @param _pulse - Pulse emitter for periodic updates.
   * @param _extensionUri - The extension's root URI (used for local resource roots).
   * @param releaseManager - Release manager for state transitions and operations.
   */
  private constructor(
    panel: vscode.WebviewPanel,
    releaseId: string,
    private _getReleaseData: (id: string) => ReleaseDefinition | undefined,
    dialogService: IDialogService,
    private _pulse: IPulseEmitter,
    private _extensionUri: vscode.Uri,
    releaseManager: IReleaseManager
  ) {
    this._panel = panel;
    this._releaseId = releaseId;
    
    // Build the delegate that bridges controller → VS Code APIs
    const delegate: ReleaseManagementDelegate = {
      executeCommand: (cmd, ...args) => vscode.commands.executeCommand(cmd, ...args) as Promise<void>,
      postMessage: (msg) => {
        if (!this._disposed) {
          try { this._panel.webview.postMessage(msg); } catch { /* panel disposed */ }
        }
      },
      forceFullRefresh: () => this._forceFullRefresh(),
    };
    this._controller = new ReleaseManagementController(releaseId, dialogService, delegate, releaseManager);
    
    // Initial render
    this._update();
    
    // Subscribe to pulse — forward to webview for client-side duration ticking
    this._pulseSubscription = this._pulse.onPulse(() => {
      if (!this._disposed) {
        try { this._panel.webview.postMessage({ type: 'pulse' }); } catch { /* panel disposed */ }
      }
    });
    
    // Handle panel disposal
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    
    // Handle messages from webview
    this._panel.webview.onDidReceiveMessage(
      message => this._controller.handleMessage(message),
      null,
      this._disposables
    );
  }
  
  /**
   * Create a new release panel for the given Release, or reveal an existing one.
   *
   * If a panel for `releaseId` already exists, it is brought to the foreground.
   * Otherwise a new {@link vscode.WebviewPanel} is created in
   * {@link vscode.ViewColumn.One} with scripts enabled and context retention.
   *
   * @param extensionUri - The extension's root URI (used for local resource roots).
   * @param releaseId - The unique identifier of the Release to display.
   * @param getReleaseData - Function to fetch release data.
   * @param releaseManager - Release manager for state transitions and operations.
   */
  public static createOrShow(
    extensionUri: vscode.Uri,
    releaseId: string,
    getReleaseData: (id: string) => ReleaseDefinition | undefined,
    releaseManager: IReleaseManager,
    options?: { preserveFocus?: boolean },
    dialogService?: IDialogService,
    pulse?: IPulseEmitter
  ) {
    const preserveFocus = options?.preserveFocus ?? false;
    
    // Check if panel already exists
    const existing = ReleaseManagementPanel.panels.get(releaseId);
    if (existing) {
      existing._panel.reveal(undefined, preserveFocus);
      return;
    }
    
    const release = getReleaseData(releaseId);
    const title = release ? `Release: ${release.name}` : `Release: ${releaseId.slice(0, 8)}`;
    
    // Create new panel
    const panel = vscode.window.createWebviewPanel(
      'releaseManagement',
      title,
      { viewColumn: vscode.ViewColumn.One, preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );
    
    // Default dialog service using VS Code APIs
    const defaultDialogService: IDialogService = {
      showInfo: async (msg: string) => { vscode.window.showInformationMessage(msg); },
      showError: async (msg: string) => { vscode.window.showErrorMessage(msg); },
      showWarning: async (msg: string, opts?: { modal?: boolean }, ...actions: string[]) => {
        return vscode.window.showWarningMessage(msg, opts || {}, ...actions) as Promise<string | undefined>;
      },
      showQuickPick: async (items: string[], opts?: any) => {
        const result = await vscode.window.showQuickPick(items, opts);
        return Array.isArray(result) ? result[0] : result;
      },
    };
    const effectiveDialogService = dialogService ?? defaultDialogService;
    
    // Default pulse emitter (no-op) if not provided
    const effectivePulse: IPulseEmitter = pulse ?? { onPulse: () => ({ dispose: () => {} }), isRunning: false };
    
    const releasePanel = new ReleaseManagementPanel(panel, releaseId, getReleaseData, effectiveDialogService, effectivePulse, extensionUri, releaseManager);
    ReleaseManagementPanel.panels.set(releaseId, releasePanel);
  }
  
  /**
   * Close the panel associated with a Release (used when Release is deleted).
   *
   * @param releaseId - The Release ID whose panel should be closed.
   */
  public static closeForRelease(releaseId: string): void {
    const panel = ReleaseManagementPanel.panels.get(releaseId);
    if (panel) {
      panel.dispose();
    }
  }
  
  /** Dispose the panel, clear timers, and remove it from the static panel map. */
  public dispose() {
    this._disposed = true;
    ReleaseManagementPanel.panels.delete(this._releaseId);
    
    if (this._pulseSubscription) {
      this._pulseSubscription.dispose();
    }
    
    this._panel.dispose();
    
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) {d.dispose();}
    }
  }
  
  /**
   * Force a full HTML refresh (re-renders the entire panel).
   */
  private _forceFullRefresh() {
    this._update();
  }
  
  /**
   * Update the webview HTML with the latest release data.
   */
  private _update() {
    if (this._disposed) { return; }
    
    const release = this._getReleaseData(this._releaseId);
    if (!release) {
      this._panel.webview.html = errorPageHtml('Release not found');
      return;
    }
    
    this._panel.webview.html = this._getHtmlForWebview(release);
  }
  
  /**
   * Build the complete HTML for the webview.
   */
  private _getHtmlForWebview(release: ReleaseDefinition): string {
    const nonce = this._getNonce();
    const csp = this._panel.webview.cspSource;
    
    // Import template modules (will be created next)
    const { renderReleaseStyles } = require('../templates/release/stylesTemplate');
    const { renderReleaseBody } = require('../templates/release/bodyTemplate');
    const { renderReleaseScripts } = require('../templates/release/scriptsTemplate');
    
    const scriptTag = webviewScriptTag(this._panel.webview, this._extensionUri, 'release');
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${csp} data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Release: ${escapeHtml(release.name)}</title>
  <style>
    ${renderReleaseStyles()}
  </style>
</head>
<body>
  ${renderReleaseBody(release)}
  ${scriptTag}
  ${renderReleaseScripts(release)}
</body>
</html>`;
  }
  
  /**
   * Generate a cryptographic nonce for CSP.
   */
  private _getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
