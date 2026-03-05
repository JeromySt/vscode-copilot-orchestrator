/**
 * @fileoverview Active PR Panel
 * 
 * Shows detailed view of a managed pull request with:
 * - PR header with status and metadata
 * - Lifecycle action buttons
 * - Monitoring status and statistics
 * - Activity log
 * 
 * @module ui/panels/activePRPanel
 */

import * as vscode from 'vscode';
import { escapeHtml } from '../templates';
import { renderActivePRStyles, renderActivePRBody, renderActivePRScripts } from '../templates/activePR';
import type { ManagedPR } from '../../plan/types/prLifecycle';
import { ActivePRController } from './activePRController';
import type { ActivePRDelegate } from './activePRController';
import type { IDialogService } from '../../interfaces/IDialogService';
import type { IPulseEmitter, Disposable as PulseDisposable } from '../../interfaces/IPulseEmitter';
import { webviewScriptTag } from '../webviewUri';

/**
 * Webview panel that shows a detailed view of a single managed pull request.
 *
 * Displays PR metadata, lifecycle action buttons, monitoring status,
 * and activity log with real-time updates.
 *
 * Only one panel is created per PR ID — subsequent calls to
 * {@link createOrShow} reveal the existing panel.
 *
 * **Webview → Extension messages:**
 * - `{ type: 'monitor' }` — start monitoring the PR
 * - `{ type: 'pause' }` — pause PR monitoring
 * - `{ type: 'promote' }` — promote PR to ready for review
 * - `{ type: 'demote' }` — convert PR to draft
 * - `{ type: 'abandon' }` — stop managing the PR
 * - `{ type: 'remove' }` — remove PR from management
 * - `{ type: 'refresh' }` — request a manual data refresh
 * - `{ type: 'openPR', url: string }` — open PR in browser
 *
 * **Extension → Webview messages:**
 * - Full HTML re-render via `webview.html` on each update cycle
 * - `{ type: 'pulse' }` — periodic pulse for timer updates
 */
export class ActivePRPanel {
  private static panels = new Map<string, ActivePRPanel>();
  
  private readonly _panel: vscode.WebviewPanel;
  private _managedPRId: string;
  private _disposables: vscode.Disposable[] = [];
  private _pulseSubscription?: PulseDisposable;
  private readonly _controller: ActivePRController;
  private _disposed = false;
  
  /**
   * @param panel - The VS Code webview panel instance.
   * @param managedPRId - Unique identifier of the managed PR to display.
   * @param _getPRData - Function to retrieve current PR data.
   * @param dialogService - Abstraction over VS Code dialog APIs.
   * @param _pulse - Pulse emitter for periodic updates.
   * @param _extensionUri - The extension's root URI (used for local resource roots).
   */
  private constructor(
    panel: vscode.WebviewPanel,
    managedPRId: string,
    private _getPRData: (id: string) => ManagedPR | undefined,
    dialogService: IDialogService,
    private _pulse: IPulseEmitter,
    private _extensionUri: vscode.Uri
  ) {
    this._panel = panel;
    this._managedPRId = managedPRId;
    
    // Build the delegate that bridges controller → VS Code APIs
    const delegate: ActivePRDelegate = {
      executeCommand: (cmd, ...args) => vscode.commands.executeCommand(cmd, ...args) as Promise<void>,
      postMessage: (msg) => {
        if (!this._disposed) {
          try { this._panel.webview.postMessage(msg); } catch { /* panel disposed */ }
        }
      },
      forceFullRefresh: () => this._update(),
    };
    this._controller = new ActivePRController(managedPRId, dialogService, delegate);
    
    // Initial render
    this._update();
    
    // Subscribe to pulse — forward to webview for client-side duration ticking.
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
   * Create a new detail panel for the given managed PR, or reveal an existing one.
   *
   * If a panel for `managedPRId` already exists, it is brought to the foreground.
   * Otherwise a new {@link vscode.WebviewPanel} is created in
   * {@link vscode.ViewColumn.One} with scripts enabled and context retention.
   *
   * @param extensionUri - The extension's root URI (used for local resource roots).
   * @param managedPRId - The unique identifier of the managed PR to display.
   * @param getPRData - Function to retrieve current PR data.
   * @param options - Optional configuration.
   * @param dialogService - Optional dialog service.
   * @param pulse - Optional pulse emitter.
   */
  public static createOrShow(
    extensionUri: vscode.Uri,
    managedPRId: string,
    getPRData: (id: string) => ManagedPR | undefined,
    options?: { preserveFocus?: boolean },
    dialogService?: IDialogService,
    pulse?: IPulseEmitter
  ) {
    const preserveFocus = options?.preserveFocus ?? false;
    
    // Check if panel already exists
    const existing = ActivePRPanel.panels.get(managedPRId);
    if (existing) {
      existing._panel.reveal(undefined, preserveFocus);
      return;
    }
    
    const pr = getPRData(managedPRId);
    const title = pr ? `PR #${pr.prNumber}: ${pr.title}` : `PR: ${managedPRId.slice(0, 8)}`;
    
    // Create new panel
    const panel = vscode.window.createWebviewPanel(
      'activePR',
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
    
    const prPanel = new ActivePRPanel(panel, managedPRId, getPRData, effectiveDialogService, effectivePulse, extensionUri);
    ActivePRPanel.panels.set(managedPRId, prPanel);
  }
  
  /**
   * Close all panels associated with a managed PR (used when PR is removed).
   *
   * @param managedPRId - The managed PR ID whose panel should be closed.
   */
  public static closeForPR(managedPRId: string): void {
    const panel = ActivePRPanel.panels.get(managedPRId);
    if (panel) {
      panel.dispose();
    }
  }
  
  /** Dispose the panel, clear timers, and remove it from the static panel map. */
  public dispose() {
    this._disposed = true;
    ActivePRPanel.panels.delete(this._managedPRId);
    
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
   * Update the webview HTML with current PR data.
   */
  private _update() {
    if (this._disposed) { return; }
    
    const pr = this._getPRData(this._managedPRId);
    if (!pr) {
      this._panel.webview.html = this._getErrorHtml('Managed PR not found');
      return;
    }
    
    this._panel.webview.html = this._getHtmlForWebview(pr);
    
    // Update panel title
    this._panel.title = `PR #${pr.prNumber}: ${pr.title}`;
  }
  
  /**
   * Generate the full HTML content for the webview.
   */
  private _getHtmlForWebview(pr: ManagedPR): string {
    const webview = this._panel.webview;
    const nonce = getNonce();
    
    // Get script URI for webview entry point
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'activePR.js')
    );
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Active PR: ${escapeHtml(pr.title)}</title>
  ${renderActivePRStyles()}
</head>
<body>
  ${renderActivePRBody(pr)}
  ${renderActivePRScripts(scriptUri.toString(), nonce)}
</body>
</html>`;
  }
  
  /**
   * Generate error page HTML.
   */
  private _getErrorHtml(message: string): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error</title>
  <style>
    body {
      padding: 20px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .error {
      padding: 20px;
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      border-radius: 4px;
      color: var(--vscode-errorForeground);
    }
  </style>
</head>
<body>
  <div class="error">
    <h2>Error</h2>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
  }
}

/**
 * Generate a cryptographically secure random nonce for CSP.
 */
function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
