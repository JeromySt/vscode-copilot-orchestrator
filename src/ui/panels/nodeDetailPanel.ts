/**
 * @fileoverview Node Detail Panel
 * 
 * Shows detailed view of a single node including:
 * - Execution state with phase tabs
 * - Log viewer with live streaming
 * - Work summary with commit details
 * - Process tree for running jobs
 * 
 * Ported from the legacy Job Details panel to work with Plan nodes.
 * 
 * @module ui/panels/nodeDetailPanel
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { PlanRunner, PlanInstance, JobNode, NodeExecutionState, JobWorkSummary, WorkSpec, normalizeWorkSpec } from '../../plan';
import { escapeHtml, formatDuration, errorPageHtml, loadingPageHtml, commitDetailsHtml, workSummaryStatsHtml } from '../templates';
import { getNodeMetrics } from '../../plan/metricsAggregator';
import {
  breadcrumbHtml, headerRowHtml, executionStateHtml,
  retryButtonsHtml, forceFailButtonHtml, bottomActionsHtml,
  processTreeSectionHtml, logViewerSectionHtml,
  dependenciesSectionHtml, gitInfoSectionHtml,
  metricsSummaryHtml, attemptMetricsHtml as attemptMetricsTemplateHtml,
  attemptHistoryHtml, webviewScripts,
  renderSpecContent, getSpecTypeInfo,
} from '../templates/nodeDetail';
import type { AttemptCardData } from '../templates/nodeDetail';
import { NodeDetailController, NodeDetailCommands } from './nodeDetailController';
import type { IPulseEmitter, Disposable as PulseDisposable } from '../../interfaces/IPulseEmitter';

/**
 * Format a {@link WorkSpec} as a plain-text summary string.
 *
 * @param spec - The work specification to format.
 * @returns A human-readable text representation of the work spec, or empty string if undefined.
 */
function formatWorkSpec(spec: WorkSpec | undefined): string {
  if (!spec) {return '';}
  
  if (typeof spec === 'string') {
    return spec;
  }
  
  switch (spec.type) {
    case 'process':
      const args = spec.args?.join(' ') || '';
      return `[process] ${spec.executable} ${args}`.trim();
    case 'shell':
      const shell = spec.shell ? `[${spec.shell}] ` : '';
      return `${shell}${spec.command}`;
    case 'agent':
      return `[agent] ${spec.instructions}`;
    default:
      return JSON.stringify(spec);
  }
}

/**
 * Format a {@link WorkSpec} as HTML with type badges and styled commands.
 *
 * Renders `process` and `shell` specs as `<code>` blocks with type badges,
 * and `agent` specs as Markdown-rendered instruction blocks.
 *
 * @param spec - The work specification to format.
 * @param escapeHtml - HTML escaping function for sanitizing user-supplied text.
 * @returns An HTML fragment string, or empty string if the spec is undefined.
 */
/**
 * Get a display-friendly shell type name for the badge.
 */
function getShellDisplayName(shell: string | undefined): { name: string; lang: string } {
  if (!shell) {return { name: 'Shell', lang: 'shell' };}
  const lower = shell.toLowerCase();
  if (lower.includes('powershell')) {return { name: 'PowerShell', lang: 'powershell' };}
  if (lower.includes('pwsh')) {return { name: 'PowerShell', lang: 'powershell' };}
  if (lower.includes('bash')) {return { name: 'Bash', lang: 'bash' };}
  if (lower.includes('zsh')) {return { name: 'Zsh', lang: 'bash' };}
  if (lower.includes('cmd')) {return { name: 'CMD', lang: 'batch' };}
  if (lower.includes('sh')) {return { name: 'Shell', lang: 'shell' };}
  return { name: shell, lang: 'shell' };
}

function formatWorkSpecHtml(spec: WorkSpec | undefined, escapeHtml: (s: string) => string): string {
  if (!spec) {return '';}
  
  if (typeof spec === 'string') {
    return `<div class="work-code-block">
      <div class="work-code-header"><span class="work-lang-badge">Command</span></div>
      <pre class="work-code"><code>${escapeHtml(spec)}</code></pre>
    </div>`;
  }
  
  switch (spec.type) {
    case 'process': {
      const args = spec.args?.join(' ') || '';
      const cmd = `${spec.executable} ${args}`.trim();
      return `<div class="work-code-block">
        <div class="work-code-header"><span class="work-lang-badge process">Process</span></div>
        <pre class="work-code"><code>${escapeHtml(cmd)}</code></pre>
      </div>`;
    }
    case 'shell': {
      const { name } = getShellDisplayName(spec.shell);
      // Format long commands with line breaks for readability
      const formattedCmd = formatShellCommand(spec.command);
      return `<div class="work-code-block">
        <div class="work-code-header"><span class="work-lang-badge shell">${escapeHtml(name)}</span></div>
        <pre class="work-code"><code>${escapeHtml(formattedCmd)}</code></pre>
      </div>`;
    }
    case 'agent': {
      // Render agent instructions as Markdown
      const instructions = spec.instructions || '';
      const rendered = renderMarkdown(instructions, escapeHtml);
      const modelLabel = spec.model ? escapeHtml(spec.model) : 'unspecified';
      return `<div class="work-code-block agent-block">
        <div class="work-code-header"><span class="work-lang-badge agent">Agent</span><span class="agent-model">${modelLabel}</span></div>
        <div class="work-instructions">${rendered}</div>
      </div>`;
    }
    default:
      return `<div class="work-code-block">
        <div class="work-code-header"><span class="work-lang-badge">Config</span></div>
        <pre class="work-code"><code>${escapeHtml(JSON.stringify(spec, null, 2))}</code></pre>
      </div>`;
  }
}

/**
 * Format a shell command for better readability.
 * Breaks long commands at semicolons and pipes for multi-line display.
 */
function formatShellCommand(cmd: string): string {
  if (!cmd || cmd.length < 80) {return cmd;}
  
  // Replace semicolons with semicolon + newline (but preserve quoted strings)
  // Simple approach: break at ; and | that aren't inside quotes
  let result = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let indent = '  ';
  
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const prevCh = i > 0 ? cmd[i - 1] : '';
    
    if (ch === "'" && prevCh !== '\\' && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (ch === '"' && prevCh !== '\\' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    }
    
    if (!inSingleQuote && !inDoubleQuote) {
      // Break after ; or | followed by space or command
      if (ch === ';' || ch === '|') {
        result += ch;
        // Skip any following whitespace
        while (i + 1 < cmd.length && cmd[i + 1] === ' ') {
          i++;
        }
        if (i + 1 < cmd.length) {
          result += '\n' + indent;
        }
        continue;
      }
    }
    
    result += ch;
  }
  
  return result;
}

/**
 * Convert a subset of Markdown to HTML for rendering agent instructions.
 *
 * Supports headers (`#`–`######`), ordered/unordered lists, fenced code blocks,
 * inline code, bold, italic, and `[text](url)` links.
 *
 * @param md - Raw Markdown source string.
 * @param escapeHtml - HTML escaping function for sanitizing text content.
 * @returns An HTML fragment string.
 */
function renderMarkdown(md: string, escapeHtml: (s: string) => string): string {
  const lines = md.split('\n');
  let html = '';
  let inCodeBlock = false;
  let codeBlockContent = '';
  let inOrderedList = false;
  let inUnorderedList = false;
  
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    
    // Code blocks (```)
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        html += `<pre class="md-code-block"><code>${escapeHtml(codeBlockContent.trim())}</code></pre>`;
        codeBlockContent = '';
        inCodeBlock = false;
      } else {
        closeLists();
        inCodeBlock = true;
      }
      continue;
    }
    
    if (inCodeBlock) {
      codeBlockContent += line + '\n';
      continue;
    }
    
    const trimmed = line.trim();
    
    // Empty line - close lists
    if (!trimmed) {
      closeLists();
      continue;
    }
    
    // Headers
    const headerMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headerMatch) {
      closeLists();
      const level = headerMatch[1].length;
      const text = formatInline(headerMatch[2], escapeHtml);
      html += `<h${level + 2} class="md-header">${text}</h${level + 2}>`;
      continue;
    }
    
    // Ordered list (1. 2. 3.)
    const orderedMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (orderedMatch) {
      if (inUnorderedList) { html += '</ul>'; inUnorderedList = false; }
      if (!inOrderedList) { html += '<ol class="md-list">'; inOrderedList = true; }
      html += `<li>${formatInline(orderedMatch[2], escapeHtml)}</li>`;
      continue;
    }
    
    // Unordered list (- or *)
    const unorderedMatch = trimmed.match(/^[-*]\s+(.*)$/);
    if (unorderedMatch) {
      if (inOrderedList) { html += '</ol>'; inOrderedList = false; }
      if (!inUnorderedList) { html += '<ul class="md-list">'; inUnorderedList = true; }
      html += `<li>${formatInline(unorderedMatch[1], escapeHtml)}</li>`;
      continue;
    }
    
    // Regular paragraph
    closeLists();
    html += `<p class="md-para">${formatInline(trimmed, escapeHtml)}</p>`;
  }
  
  closeLists();
  if (inCodeBlock) {
    html += `<pre class="md-code-block"><code>${escapeHtml(codeBlockContent.trim())}</code></pre>`;
  }
  
  return html;
  
  function closeLists() {
    if (inOrderedList) { html += '</ol>'; inOrderedList = false; }
    if (inUnorderedList) { html += '</ul>'; inUnorderedList = false; }
  }
}

/**
 * Apply inline Markdown formatting (bold, italic, code, links) to a single line.
 *
 * @param text - The raw text to format (already split from block elements).
 * @param escapeHtml - HTML escaping function.
 * @returns The text with inline Markdown converted to HTML spans.
 */
function formatInline(text: string, escapeHtml: (s: string) => string): string {
  // First escape HTML
  let result = escapeHtml(text);
  
  // Inline code (`code`) - do this first to protect code from other formatting
  result = result.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
  
  // Bold (**text** or __text__) - do before italic
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  
  // Italic (*text* or _text_) - since bold is already replaced, single * or _ won't conflict
  result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  result = result.replace(/\b_([^_]+)_\b/g, '<em>$1</em>');
  
  // Links [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="md-link">$1</a>');
  
  return result;
}

/**
 * Get the current execution phase from node state.
 */
function getCurrentExecutionPhase(state: NodeExecutionState | undefined): string | undefined {
  if (!state?.stepStatuses) {return undefined;}
  
  // Check which phase is currently running (includes merge phases)
  for (const [phase, status] of Object.entries(state.stepStatuses)) {
    if (status === 'running') {
      return phase;
    }
  }
  
  // If nothing is currently running, return the first incomplete phase
  const phaseOrder = ['merge-fi', 'prechecks', 'work', 'commit', 'postchecks', 'merge-ri'];
  for (const phase of phaseOrder) {
    const status = state.stepStatuses[phase as keyof typeof state.stepStatuses];
    if (!status || status === 'pending') {
      return phase;
    }
  }
  
  return undefined;
}

/**
 * Webview panel that shows detailed information for a single Plan node.
 *
 * Displays execution state with phase tabs (merge-fi, prechecks, work, commit,
 * postchecks, merge-ri), a live-streaming log viewer, work summary with commit
 * details, process tree for running jobs, and retry controls.
 *
 * Only one panel is created per Plan ID + node ID pair — subsequent calls to
 * {@link createOrShow} reveal the existing panel and trigger an update.
 *
 * **Webview → Extension messages:**
 * - `{ type: 'openPlan', planId: string }` — navigate to the parent Plan panel
 * - `{ type: 'openWorktree' }` — open the node's worktree folder in a new VS Code window
 * - `{ type: 'refresh' }` — request a full data refresh
 * - `{ type: 'getLog', phase: string }` — request log content for a specific execution phase
 * - `{ type: 'getProcessStats' }` — request current process tree statistics
 * - `{ type: 'copyToClipboard', text: string }` — copy text to the system clipboard
 * - `{ type: 'retryNode', planId: string, nodeId: string, resumeSession: boolean }` — retry the node
 *
 * **Extension → Webview messages:**
 * - `{ type: 'logContent', phase: string, content: string }` — log data for a phase
 * - `{ type: 'processStats', ... }` — process tree statistics
 *
 * @see {@link planDetailPanel} for the parent Plan detail view
 */
export class NodeDetailPanel {
  private static panels = new Map<string, NodeDetailPanel>();
  
  private readonly _panel: vscode.WebviewPanel;
  private _planId: string;
  private _nodeId: string;
  private _disposables: vscode.Disposable[] = [];
  private _pulseSubscription?: PulseDisposable;
  private _currentPhase: string | null = null;
  private _lastStatus: string | null = null;
  private _lastWorktreeCleanedUp: boolean | undefined = undefined;
  private _controller: NodeDetailController;
  
  /**
   * @param panel - The VS Code webview panel instance.
   * @param planId - The Plan ID that contains this node.
   * @param nodeId - The unique identifier of the node to display.
   * @param _planRunner - The {@link PlanRunner} instance for querying state and logs.
   * @param _pulse - Pulse emitter for periodic updates.
   */
  private constructor(
    panel: vscode.WebviewPanel,
    planId: string,
    nodeId: string,
    private _planRunner: PlanRunner,
    private _pulse: IPulseEmitter
  ) {
    this._panel = panel;
    this._planId = planId;
    this._nodeId = nodeId;
    
    // Create controller with VS Code service adapters
    const commands: NodeDetailCommands = {
      executeCommand: (cmd, ...args) => vscode.commands.executeCommand(cmd, ...args),
      openFolder: (p) => vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p), { forceNewWindow: true }),
      refresh: () => this._update(),
      sendLog: (phase) => { this._currentPhase = phase; this._sendLog(phase); },
      sendProcessStats: () => this._sendProcessStats(),
      retryNode: (pid, nid, resume) => this._retryNode(pid, nid, resume),
      forceFailNode: (pid, nid) => this._forceFailNode(pid, nid),
      openFile: (p) => {
        if (path.isAbsolute(p) && fs.existsSync(p)) {
          vscode.commands.executeCommand('vscode.open', vscode.Uri.file(p));
        }
      },
      getWorktreePath: () => {
        const plan = this._planRunner.get(this._planId);
        const state = plan?.nodeStates.get(this._nodeId);
        return state?.worktreePath;
      },
    };
    const dialogService = {
      showInfo: async (msg: string) => { vscode.window.showInformationMessage(msg); },
      showError: async (msg: string) => { vscode.window.showErrorMessage(msg); },
      showWarning: async (msg: string, opts?: { modal?: boolean }, ...actions: string[]) => {
        return vscode.window.showWarningMessage(msg, opts || {}, ...actions);
      },
      showQuickPick: async (items: string[], opts?: any) => vscode.window.showQuickPick(items, opts) as Promise<string | undefined>,
    };
    const clipboardService = {
      writeText: async (text: string) => { await vscode.env.clipboard.writeText(text); },
    };
    this._controller = new NodeDetailController(planId, nodeId, dialogService, clipboardService, commands);
    
    // Show loading state immediately
    this._panel.webview.html = this._getLoadingHtml();
    
    // Initial render (deferred)
    setImmediate(() => {
      // Set _lastStatus before first render to prevent the interval from
      // immediately triggering a redundant full update that kills the
      // client-side duration timer
      const plan = this._planRunner.get(this._planId);
      const state = plan?.nodeStates.get(this._nodeId);
      this._lastStatus = state?.status || null;
      this._lastWorktreeCleanedUp = state?.worktreeCleanedUp;
      this._update();
    });
    
    // Subscribe to pulse for periodic state checks
    this._pulseSubscription = this._pulse.onPulse(() => {
      // Forward pulse to webview for DurationCounter ticking
      this._panel.webview.postMessage({ type: 'pulse' });

      const plan = this._planRunner.get(this._planId);
      const state = plan?.nodeStates.get(this._nodeId);

      // Always send incremental state change so header phase indicator updates
      if (state) {
        const phaseStatus = this._getPhaseStatus(state);
        const currentPhase = getCurrentExecutionPhase(state);
        this._panel.webview.postMessage({
          type: 'stateChange',
          status: state.status,
          phaseStatus,
          currentPhase,
        });
      }

      if (state?.status === 'running' || state?.status === 'scheduled') {
        // Status changed - do full update
        if (this._lastStatus !== state.status) {
          this._lastStatus = state.status;
          this._update();
        } else if (this._currentPhase) {
          // Push log lines on arrival
          this._sendLog(this._currentPhase);
        }
        // Push process stats on each pulse while active
        this._sendProcessStats();
      } else if (this._lastStatus === 'running' || this._lastStatus === 'scheduled') {
        // Transitioned from running to terminal - do full update
        this._lastStatus = state?.status || null;
        this._update();
        // Send final log update
        if (this._currentPhase) {
          this._sendLog(this._currentPhase);
        }
      } else {
        // Terminal state - check for worktree cleanup or other state changes
        if (state?.worktreeCleanedUp !== this._lastWorktreeCleanedUp) {
          this._lastWorktreeCleanedUp = state?.worktreeCleanedUp;
          this._update();
        }
      }
    });
    
    // Handle panel disposal
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    
    // Handle messages
    this._panel.webview.onDidReceiveMessage(
      message => this._handleMessage(message),
      null,
      this._disposables
    );
  }
  
  /**
   * Create a new detail panel for the given node, or reveal an existing one.
   *
   * If a panel for the `planId:nodeId` pair already exists, it is revealed and
   * refreshed. Otherwise a new {@link vscode.WebviewPanel} is created in
   * {@link vscode.ViewColumn.Two}.
   *
   * @param extensionUri - The extension's root URI (used for local resource roots).
   * @param planId - The Plan that contains the target node.
   * @param nodeId - The unique identifier of the node to display.
   * @param planRunner - The {@link PlanRunner} instance for querying state.
   */
  public static createOrShow(
    extensionUri: vscode.Uri,
    planId: string,
    nodeId: string,
    planRunner: PlanRunner,
    pulse?: IPulseEmitter
  ) {
    const key = `${planId}:${nodeId}`;
    
    const existing = NodeDetailPanel.panels.get(key);
    if (existing) {
      existing._panel.reveal();
      existing._update();
      return;
    }
    
    const plan = planRunner.get(planId);
    const node = plan?.nodes.get(nodeId);
    const title = node ? `Node: ${node.name}` : `Node: ${nodeId.slice(0, 8)}`;
    
    const panel = vscode.window.createWebviewPanel(
      'nodeDetail',
      title,
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );
    
    // Default pulse emitter (no-op) if not provided
    const effectivePulse: IPulseEmitter = pulse ?? { onPulse: () => ({ dispose: () => {} }), isRunning: false };
    
    const nodePanel = new NodeDetailPanel(panel, planId, nodeId, planRunner, effectivePulse);
    NodeDetailPanel.panels.set(key, nodePanel);
  }
  
  /**
   * Close all node panels associated with a Plan (used when a Plan is deleted).
   *
   * @param planId - The Plan ID whose node panels should be closed.
   */
  public static closeForPlan(planId: string): void {
    // Find and close all panels whose key starts with this planId
    const keysToClose: string[] = [];
    for (const key of NodeDetailPanel.panels.keys()) {
      if (key.startsWith(`${planId}:`)) {
        keysToClose.push(key);
      }
    }
    for (const key of keysToClose) {
      const panel = NodeDetailPanel.panels.get(key);
      if (panel) {
        panel.dispose();
      }
    }
  }
  
  /** Dispose the panel, clear timers, and remove it from the static panel map. */
  public dispose() {
    const key = `${this._planId}:${this._nodeId}`;
    NodeDetailPanel.panels.delete(key);
    
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
   * Handle incoming messages from the webview by delegating to the controller.
   *
   * @param message - The message object received from the webview's `postMessage`.
   */
  private _handleMessage(message: any) {
    this._controller.handleMessage(message);
  }
  
  /**
   * Force a stuck running node to failed state so it can be retried.
   *
   * @param planId - The Plan containing the node.
   * @param nodeId - The node to force fail.
   */
  private async _forceFailNode(planId: string, nodeId: string) {
    try {
      await this._planRunner.forceFailNode(planId, nodeId);
      // Refresh panel after successful force fail
      this._update();
      vscode.window.showInformationMessage(`Node force failed. You can now retry.`);
    } catch (error) {
      console.debug('forceFailNode failed:', error);
      vscode.window.showErrorMessage(`Failed to force fail: ${error}`);
    }
  }

  /**
   * Retry a failed node, optionally resuming the existing Copilot session.
   *
   * @param planId - The Plan containing the node.
   * @param nodeId - The node to retry.
   * @param resumeSession - If `true`, resume the existing agent session;
   *   if `false`, start a fresh session.
   */
  private async _retryNode(planId: string, nodeId: string, resumeSession: boolean) {
    // If resumeSession is false, provide an agent spec that clears the session
    const newWork = resumeSession ? undefined : { type: 'agent' as const, instructions: '', resumeSession: false };
    
    const result = await this._planRunner.retryNode(planId, nodeId, {
      newWork,
      clearWorktree: false,
    });
    
    if (result.success) {
      vscode.window.showInformationMessage(`Node retry initiated${resumeSession ? ' (resuming session)' : ' (fresh session)'}`);
      this._update();
    } else {
      vscode.window.showErrorMessage(`Retry failed: ${result.error}`);
    }
  }
  
  /** Query process stats for this node and send them to the webview. */
  private async _sendProcessStats() {
    const stats = await this._planRunner.getProcessStats(this._planId, this._nodeId);
    this._panel.webview.postMessage({
      type: 'processStats',
      ...stats
    });
  }
  
  /**
   * Retrieve log content for a specific execution phase and send it to the webview.
   *
   * @param phase - The execution phase to retrieve logs for
   *   (e.g., `'work'`, `'merge-fi'`, `'postchecks'`).
   */
  private async _sendLog(phase: string) {
    const plan = this._planRunner.get(this._planId);
    const node = plan?.nodes.get(this._nodeId);
    const state = plan?.nodeStates.get(this._nodeId);
    
    // Always send a response - never leave webview hanging
    if (!plan || !node) {
      this._panel.webview.postMessage({
        type: 'logContent',
        phase,
        content: 'Plan or node not found.',
        logFilePath: undefined,
      });
      return;
    }
    
    // Get the current attempt number for per-attempt log files
    const attemptNumber = state?.attempts || 1;
    
    // Get logs from executor (works for both jobs and sub-plan nodes)
    const logs = this._planRunner.getNodeLogs(this._planId, this._nodeId, phase as any, attemptNumber);
    const logFilePath = this._planRunner.getNodeLogFilePath(this._planId, this._nodeId, attemptNumber);
    
    this._panel.webview.postMessage({
      type: 'logContent',
      phase,
      content: logs || 'No logs available for this phase.',
      logFilePath,
    });
  }

  /** Send config update to webview for live config display updates. */
  private _sendConfigUpdate() {
    const plan = this._planRunner.get(this._planId);
    const node = plan?.nodes.get(this._nodeId);
    const state = plan?.nodeStates.get(this._nodeId);
    
    if (!node || node.type !== 'job') {return;}
    
    // Extract originalInstructions from AgentSpec if augmented
    const normalizedWork = node.work ? normalizeWorkSpec(node.work) : undefined;
    const originalInstructions = normalizedWork?.type === 'agent' ? normalizedWork.originalInstructions : undefined;
    
    // Pre-render spec HTML server-side so the webview gets formatted HTML
    this._panel.webview.postMessage({
      type: 'configUpdate',
      data: {
        work: node.work ? renderSpecContent(node.work) : undefined,
        workType: node.work ? getSpecTypeInfo(node.work) : undefined,
        prechecks: node.prechecks ? renderSpecContent(node.prechecks) : undefined,
        prechecksType: node.prechecks ? getSpecTypeInfo(node.prechecks) : undefined,
        postchecks: node.postchecks ? renderSpecContent(node.postchecks) : undefined,
        postchecksType: node.postchecks ? getSpecTypeInfo(node.postchecks) : undefined,
        task: node.task,
        currentPhase: getCurrentExecutionPhase(state),
        originalInstructions,
      }
    });
  }
  
  /**
   * Push attempt history updates to the webview for dynamic rendering.
   *
   * @param state - The current node execution state.
   */
  private _sendAttemptUpdate(state: NodeExecutionState): void {
    if (!state.attemptHistory || state.attemptHistory.length === 0) {return;}
    this._panel.webview.postMessage({
      type: 'attemptUpdate',
      attempts: state.attemptHistory.map(a => ({
        attemptNumber: a.attemptNumber,
        status: a.status,
        triggerType: a.triggerType,
        startedAt: a.startedAt,
        endedAt: a.endedAt,
        error: a.error,
        failedPhase: a.failedPhase,
      })),
    });
  }

  /**
   * Push AI usage metrics to the webview.
   *
   * @param state - The current node execution state.
   */
  private _sendAiUsageUpdate(state: NodeExecutionState): void {
    const metrics = getNodeMetrics(state);
    if (!metrics) {return;}
    this._panel.webview.postMessage({
      type: 'aiUsageUpdate',
      premiumRequests: metrics.premiumRequests,
      apiTimeSeconds: metrics.apiTimeSeconds,
      sessionTimeSeconds: metrics.sessionTimeSeconds,
      modelBreakdown: metrics.modelBreakdown,
    });
  }

  /**
   * Push work summary data to the webview.
   *
   * @param state - The current node execution state.
   */
  private _sendWorkSummary(state: NodeExecutionState): void {
    if (!state.workSummary) {return;}
    const ws = state.workSummary;
    this._panel.webview.postMessage({
      type: 'workSummary',
      totalCommits: ws.commits || 0,
      filesAdded: ws.filesAdded || 0,
      filesModified: ws.filesModified || 0,
      filesDeleted: ws.filesDeleted || 0,
    });
  }
  
  /** Re-render the panel HTML with current node state. */
  private _update() {
    const plan = this._planRunner.get(this._planId);
    if (!plan) {
      this._panel.webview.html = this._getErrorHtml('Plan not found');
      return;
    }
    
    const node = plan.nodes.get(this._nodeId);
    const state = plan.nodeStates.get(this._nodeId);
    
    if (!node || !state) {
      this._panel.webview.html = this._getErrorHtml('Node not found');
      return;
    }
    
    this._panel.webview.html = this._getHtml(plan, node, state);
    
    // Send config update after rendering
    this._sendConfigUpdate();
  }
  
  /**
   * Generate a loading spinner page HTML.
   *
   * @returns Full HTML document string with a loading animation.
   */
  private _getLoadingHtml(): string {
    return loadingPageHtml('Loading node details...');
  }
  
  /**
   * Generate a minimal error page HTML.
   *
   * @param message - Error text to display.
   * @returns Full HTML document string.
   */
  private _getErrorHtml(message: string): string {
    return errorPageHtml(message);
  }

  /**
   * Build the full HTML document for the node detail view.
   *
   * Includes execution state metadata, phase tabs with log viewer, work summary,
   * child Plan summary (for sub-plan nodes), and attempt history.
   *
   * @param plan - The parent Plan instance.
   * @param node - The node definition (job).
   * @param state - The node's current execution state.
   * @returns Full HTML document string.
   */
  private _getHtml(
    plan: PlanInstance,
    node: JobNode,
    state: NodeExecutionState
  ): string {
    
    const duration = state.startedAt 
      ? formatDuration(Math.round(((state.endedAt || Date.now()) - state.startedAt) / 1000))
      : null;
    
    // Build phase status indicators
    const phaseStatus = this._getPhaseStatus(state);
    
    // Determine initial phase to show
    const initialPhase = this._getInitialPhase(phaseStatus, state.status);
    
    // Build work summary HTML
    // For leaf nodes, pass aggregated work summary to show total merged work
    const isLeaf = plan.leaves.includes(this._nodeId);
    const workSummaryHtml = state.workSummary 
      ? this._buildWorkSummaryHtml(state.workSummary, state.aggregatedWorkSummary, isLeaf)
      : '';
    
    // Get log file path for this node (use current attempt number)
    const logFilePath = this._planRunner.getNodeLogFilePath(this._planId, this._nodeId, state.attempts || 1);

    // Build attempt history HTML (only if multiple attempts)
    const attemptCards: AttemptCardData[] = [];
    if (state.attemptHistory && state.attemptHistory.length > 0) {
      for (const attempt of state.attemptHistory) {
        const card: AttemptCardData = {
          attemptNumber: attempt.attemptNumber,
          status: attempt.status,
          triggerType: attempt.triggerType,
          startedAt: attempt.startedAt,
          endedAt: attempt.endedAt,
          failedPhase: attempt.failedPhase,
          error: attempt.error,
          exitCode: attempt.exitCode,
          copilotSessionId: attempt.copilotSessionId,
          stepStatuses: attempt.stepStatuses as any,
          worktreePath: attempt.worktreePath,
          baseCommit: attempt.baseCommit,
          logFilePath: attempt.logFilePath,
          workUsedHtml: attempt.workUsed ? formatWorkSpecHtml(attempt.workUsed, escapeHtml) : undefined,
          logs: attempt.logs || '',
          metricsHtml: attempt.metrics ? attemptMetricsTemplateHtml(attempt.metrics, attempt.phaseMetrics) : '',
        };
        attemptCards.push(card);
      }
    }
    const attemptHistorySection = attemptHistoryHtml({ attempts: attemptCards });

    // Compute aggregated metrics across all attempts
    const nodeMetrics = getNodeMetrics(state);
    const nodeMetricsHtml = nodeMetrics ? metricsSummaryHtml(nodeMetrics, state.phaseMetrics) : '';

    // Build dependencies data
    const dependencies = node.dependencies.map(depId => {
      const depNode = plan.nodes.get(depId);
      const depState = plan.nodeStates.get(depId);
      return { name: depNode?.name || depId, status: depState?.status || 'pending' };
    });

    // Build action buttons data
    const actionData = {
      status: state.status,
      planId: plan.id,
      nodeId: node.id,
      worktreePath: state.worktreePath,
      worktreeCleanedUp: state.worktreeCleanedUp,
    };

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>
    ${this._getStyles()}
  </style>
</head>
<body>
  <div class="sticky-header">
  ${breadcrumbHtml(plan.id, plan.spec.name, node.name)}
  
  ${headerRowHtml(node.name, state.status, state.startedAt, state.endedAt)}
  ${forceFailButtonHtml(actionData)}
  </div>
  
  ${executionStateHtml({
    planId: plan.id,
    planName: plan.spec.name,
    nodeName: node.name,
    nodeType: node.type,
    status: state.status,
    attempts: state.attempts,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    copilotSessionId: state.copilotSessionId,
    error: state.error,
    failureReason: state.failureReason,
    lastAttemptPhase: state.lastAttempt?.phase,
    lastAttemptExitCode: state.lastAttempt?.exitCode,
  })}
  ${retryButtonsHtml(actionData)}
  
  ${nodeMetricsHtml}
  <div id="aiUsageStatsContainer" style="display:none;"></div>
  
  <div id="configDisplayContainer"></div>
  
  ${logViewerSectionHtml({
    phaseStatus,
    isRunning: state.status === 'running',
    logFilePath,
  })}
  
  ${processTreeSectionHtml({ status: state.status })}
  
  ${workSummaryHtml}
  <div id="workSummaryContainer" style="display:none;"></div>
  
  ${dependenciesSectionHtml(dependencies)}
  
  ${attemptHistorySection}
  <div class="attempt-history-container"></div>
  
  ${gitInfoSectionHtml({
    worktreePath: state.worktreePath,
    worktreeCleanedUp: state.worktreeCleanedUp,
    baseCommit: state.baseCommit,
    completedCommit: state.completedCommit,
    workCommit: state.completedCommit, // In current implementation, work commit and completed commit are the same
    baseBranch: plan.baseBranch,
    targetBranch: plan.targetBranch,
    mergedToTarget: state.mergedToTarget,
  })}
  
  ${bottomActionsHtml(actionData)}
  
  <script>
    ${webviewScripts({
      planId: plan.id,
      nodeId: node.id,
      currentPhase: this._currentPhase,
      initialPhase,
      nodeStatus: state.status,
    })}
  </script>
</body>
</html>`;
  }
  
  /**
   * Derive phase-level status indicators from the node's execution state.
   *
   * Uses `stepStatuses` when available (populated by the executor), otherwise
   * falls back to heuristic inference based on overall node status.
   *
   * @param state - The node's current execution state.
   * @returns A map of phase names (`'prechecks'`, `'work'`, `'commit'`, etc.)
   *   to status strings (`'pending'`, `'running'`, `'success'`, `'failed'`, `'skipped'`).
   */
  private _getPhaseStatus(state: NodeExecutionState): Record<string, string> {
    // Always produce all 6 phases: merge-fi, prechecks, work, commit, postchecks, merge-ri.
    // stepStatuses (from executor) covers prechecks/work/commit/postchecks.
    // Merge phases are derived from lastAttempt.phase and error messages.
    
    const result: Record<string, string> = {
      'merge-fi': 'pending',
      prechecks: 'pending',
      work: 'pending',
      commit: 'pending',
      postchecks: 'pending',
      'merge-ri': 'pending',
    };
    
    // Resolve executor stepStatuses: current state or last attempt for retried nodes
    const ss = state.stepStatuses
      || ((state.status === 'pending' || state.status === 'ready') && state.attemptHistory?.length
        ? state.attemptHistory[state.attemptHistory.length - 1].stepStatuses
        : undefined);
    
    if (ss) {
      result.prechecks = ss.prechecks || 'pending';
      result.work = ss.work || 'pending';
      result.commit = ss.commit || 'pending';
      result.postchecks = ss.postchecks || 'pending';
    }
    
    const status = state.status;
    const error = state.error || '';
    const failedPhase = state.lastAttempt?.phase;
    
    if (status === 'succeeded') {
      result['merge-fi'] = 'success';
      if (!ss) {
        result.prechecks = 'success';
        result.work = 'success';
        result.commit = 'success';
        result.postchecks = 'success';
      }
      result['merge-ri'] = 'success';
    } else if (status === 'failed') {
      // Check for merge-ri failure (via lastAttempt.phase or error message)
      if (failedPhase === 'merge-ri' || error.includes('Reverse integration merge')) {
        // All executor phases succeeded, RI merge failed
        result['merge-fi'] = 'success';
        if (!ss) {
          result.prechecks = 'success';
          result.work = 'success';
          result.commit = 'success';
          result.postchecks = 'success';
        }
        result['merge-ri'] = 'failed';
      } else if (failedPhase === 'merge-fi' || error.includes('merge sources') || error.includes('Forward integration')) {
        result['merge-fi'] = 'failed';
      } else if (!ss) {
        // No stepStatuses — derive executor phases from error message
        if (error.includes('Prechecks failed')) {
          result['merge-fi'] = 'success';
          result.prechecks = 'failed';
        } else if (error.includes('Work failed')) {
          result['merge-fi'] = 'success';
          result.prechecks = 'success';
          result.work = 'failed';
        } else if (error.includes('Commit failed') || error.includes('produced no work')) {
          result['merge-fi'] = 'success';
          result.prechecks = 'success';
          result.work = 'success';
          result.commit = 'failed';
        } else if (error.includes('Postchecks failed')) {
          result['merge-fi'] = 'success';
          result.prechecks = 'success';
          result.work = 'success';
          result.commit = 'success';
          result.postchecks = 'failed';
        } else {
          // Unknown error - assume work failed
          result['merge-fi'] = 'success';
          result.prechecks = 'success';
          result.work = 'failed';
        }
      } else {
        // stepStatuses present, non-merge failure — merge-fi presumably succeeded
        result['merge-fi'] = 'success';
      }
    } else if (status === 'running') {
      result['merge-fi'] = 'success';
      if (!ss) {
        result.prechecks = 'success';
        result.work = 'running';
      }
    }
    
    return result;
  }
  
  /**
   * Determine the initial phase to show based on current state.
   *
   * Selects the currently running phase if the node is active, the first failed
   * phase if the node has failed, or the `'work'` phase as the default.
   *
   * @param phaseStatus - Phase-to-status mapping from {@link _getPhaseStatus}.
   * @param nodeStatus - The overall node status string.
   * @returns The phase name to display initially.
   */
  private _getInitialPhase(phaseStatus: Record<string, string>, nodeStatus: string): string {
    // If node is running, show the currently running phase
    if (nodeStatus === 'running') {
      const phases = ['merge-fi', 'prechecks', 'work', 'commit', 'postchecks', 'merge-ri'];
      for (const phase of phases) {
        if (phaseStatus[phase] === 'running') {
          return phase;
        }
      }
      // Default to work if we can't tell which phase is running
      return 'work';
    }
    
    // If node failed, show the failed phase
    if (nodeStatus === 'failed') {
      const phases = ['merge-fi', 'prechecks', 'work', 'commit', 'postchecks', 'merge-ri'];
      for (const phase of phases) {
        if (phaseStatus[phase] === 'failed') {
          return phase;
        }
      }
    }
    
    // For completed or other states, show all log
    return 'all';
  }
  
  /**
   * Build an HTML work summary section from a node's {@link JobWorkSummary}.
   *
   * Renders stat cards (commits, files added/modified/deleted) and commit
   * detail lists using the shared {@link workSummaryStatsHtml} and
   * {@link commitDetailsHtml} template helpers.
   *
   * @param ws - The job work summary data.
   * @param aggregated - Optional aggregated work summary for leaf nodes (includes upstream).
   * @param isLeaf - Whether this is a leaf node in the plan.
   * @returns HTML fragment string, or empty string if no data.
   */
  private _buildWorkSummaryHtml(ws: JobWorkSummary, aggregated?: JobWorkSummary, isLeaf?: boolean): string {
    const hasNodeWork = ws && (ws.commits > 0 || ws.filesAdded > 0 || ws.filesModified > 0 || ws.filesDeleted > 0);
    const hasAggregatedWork = isLeaf && aggregated && (aggregated.commits > 0 || aggregated.filesAdded > 0 || aggregated.filesModified > 0 || aggregated.filesDeleted > 0);
    if (!hasNodeWork && !hasAggregatedWork) {
      return '';
    }
    
    const commitsHtml = commitDetailsHtml(ws?.commitDetails || []);
    
    // Build aggregated work section for leaf nodes if different from job work
    let aggregatedHtml = '';
    if (isLeaf && aggregated && aggregated !== ws) {
      const aggAdded = aggregated.filesAdded || 0;
      const aggModified = aggregated.filesModified || 0;
      const aggDeleted = aggregated.filesDeleted || 0;
      
      // Only show if aggregated stats differ or are meaningful
      if (aggAdded !== ws.filesAdded || aggModified !== ws.filesModified || aggDeleted !== ws.filesDeleted) {
        aggregatedHtml = `
        <div class="work-summary-section aggregated">
          <h4>📦 Total Work Merged to Target</h4>
          <div class="work-summary-stats aggregated-stats">
            <div class="work-stat added">
              <div class="work-stat-value">+${aggAdded}</div>
              <div class="work-stat-label">Added</div>
            </div>
            <div class="work-stat modified">
              <div class="work-stat-value">~${aggModified}</div>
              <div class="work-stat-label">Modified</div>
            </div>
            <div class="work-stat deleted">
              <div class="work-stat-value">-${aggDeleted}</div>
              <div class="work-stat-label">Deleted</div>
            </div>
          </div>
          <p class="work-summary-desc">Includes all upstream dependency work</p>
        </div>
        `;
      }
    }
    
    return `
    <div class="section">
      <h3>Work Summary</h3>
      <div class="work-summary-stats">
        ${workSummaryStatsHtml(ws)}
      </div>
      ${ws.description ? `<div class="work-summary-desc">${escapeHtml(ws.description)}</div>` : ''}
      ${commitsHtml}
      ${aggregatedHtml}
    </div>
    `;
  }
  
  /**
   * Generate the shared CSS styles used across the node detail panel.
   *
   * Includes styles for phase tabs, log viewer, status badges, meta grid,
   * work summary, process tree, breadcrumb navigation, and attempt history cards.
   *
   * @returns CSS style string (without `<style>` tags).
   */
  private _getStyles(): string {
    return `
    * { box-sizing: border-box; }
    body {
      font: 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      padding: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      line-height: 1.5;
    }
    
    /* Sticky header */
    .sticky-header {
      position: sticky;
      top: 0;
      z-index: 100;
      background: var(--vscode-editor-background);
      padding: 12px 16px 8px 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .sticky-header + * {
      padding-top: 8px;
    }
    body > *:not(.sticky-header) {
      padding-left: 16px;
      padding-right: 16px;
    }
    
    /* Force Fail button in sticky header */
    .force-fail-btn {
      padding: 4px 12px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      margin-top: 8px;
      background: var(--vscode-inputValidation-errorBackground, rgba(244, 135, 113, 0.2));
      color: #f48771;
    }
    .force-fail-btn:hover {
      background: rgba(244, 135, 113, 0.4);
    }
    
    /* Header */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }
    .header h2 { margin: 0; font-size: 18px; flex: 1; margin-left: 12px; }
    
    /* Phase indicator in header */
    .header-phase {
      font-size: 11px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 10px;
      background: rgba(0, 122, 204, 0.15);
      color: #3794ff;
      white-space: nowrap;
      margin-right: 12px;
      animation: pulse-phase-badge 2s infinite;
    }
    @keyframes pulse-phase-badge {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }
    
    /* Duration display in header */
    .header-duration {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }
    .duration-icon { font-size: 16px; }
    .duration-value {
      font-family: var(--vscode-editor-font-family);
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .duration-value.running { color: #3794ff; }
    .duration-value.succeeded { color: #4ec9b0; }
    .duration-value.failed { color: #f48771; }
    
    .status-badge {
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
    }
    .status-badge.running { background: rgba(0, 122, 204, 0.2); color: #3794ff; }
    .status-badge.succeeded { background: rgba(78, 201, 176, 0.2); color: #4ec9b0; }
    .status-badge.failed { background: rgba(244, 135, 113, 0.2); color: #f48771; }
    .status-badge.pending, .status-badge.ready { background: rgba(133, 133, 133, 0.2); color: #858585; }
    .status-badge.blocked { background: rgba(133, 133, 133, 0.2); color: #858585; }
    .status-badge.scheduled { background: rgba(0, 122, 204, 0.15); color: #3794ff; }
    
    /* Breadcrumb */
    .breadcrumb {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }
    .breadcrumb a, .link {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: none;
    }
    .breadcrumb a:hover, .link:hover { text-decoration: underline; }
    
    /* Section */
    .section {
      margin-bottom: 16px;
      padding: 12px;
      background: var(--vscode-sideBar-background);
      border-radius: 8px;
    }
    .section h3 {
      margin: 0 0 10px 0;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    /* Meta Grid */
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 12px;
    }
    .meta-item { }
    .meta-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 2px;
    }
    .meta-value { font-size: 13px; }
    
    /* Git Info - stacked vertical list */
    .git-info-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .git-info-row {
      display: flex;
      flex-direction: row;
      align-items: baseline;
      gap: 12px;
    }
    .git-info-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      min-width: 120px;
      flex-shrink: 0;
    }
    .git-info-value {
      font-size: 13px;
      word-break: break-all;
    }
    .meta-value.mono, .config-value.mono {
      font-family: 'Consolas', 'Courier New', monospace;
      font-size: 12px;
      background: var(--vscode-textCodeBlock-background);
      padding: 4px 8px;
      border-radius: 4px;
      word-break: break-all;
    }
    
    /* Config Items */
    .config-item { margin-bottom: 10px; }
    .config-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }
    .config-value { }
    
    /* Config Phase Sections (Prechecks / Work / Postchecks) */
    .config-phases { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
    .config-phase { border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: hidden; }
    .config-phase-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--vscode-sideBarSectionHeader-background);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .config-phase-header.collapsed {
      cursor: pointer;
      border-bottom: none;
    }
    .config-phase-header.collapsed:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .config-phase-header.non-collapsible {
      cursor: default;
    }
    .config-collapsible-toggle { cursor: pointer; }
    .config-collapsible-toggle:hover { background: var(--vscode-list-hoverBackground); }
    .phase-label { font-size: 12px; font-weight: 600; }
    .phase-type-badge {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      padding: 2px 8px;
      border-radius: 4px;
      background: rgba(128, 128, 128, 0.2);
      color: var(--vscode-descriptionForeground);
    }
    .phase-type-badge.shell { background: rgba(72, 187, 120, 0.2); color: #48bb78; }
    .phase-type-badge.process { background: rgba(237, 137, 54, 0.2); color: #ed8936; }
    .phase-type-badge.agent { background: rgba(99, 179, 237, 0.2); color: #63b3ed; }
    .config-phase-body { padding: 8px 12px; }
    
    /* Work Display Formatting */
    .work-item .config-value {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    
    /* Code block container */
    .work-code-block {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
      background: var(--vscode-editor-background);
    }
    .work-code-block.agent-block {
      background: var(--vscode-textCodeBlock-background);
    }
    
    /* Code block header with language badge */
    .work-code-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      background: var(--vscode-sideBarSectionHeader-background);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    
    /* Language/type badge */
    .work-lang-badge {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      padding: 2px 8px;
      border-radius: 4px;
      background: rgba(128, 128, 128, 0.2);
      color: var(--vscode-descriptionForeground);
    }
    .work-lang-badge.shell {
      background: rgba(72, 187, 120, 0.2);
      color: #48bb78;
    }
    .work-lang-badge.process {
      background: rgba(237, 137, 54, 0.2);
      color: #ed8936;
    }
    .work-lang-badge.agent {
      background: rgba(99, 179, 237, 0.2);
      color: #63b3ed;
    }
    
    /* Agent model label */
    .agent-model {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    
    /* Agent instructions markdown rendering */
    .agent-instructions {
      padding: 8px 12px;
      font-size: 13px;
      line-height: 1.5;
    }
    .agent-instructions h3 { font-size: 15px; margin: 12px 0 6px; color: var(--vscode-foreground); }
    .agent-instructions h4 { font-size: 14px; margin: 10px 0 4px; color: var(--vscode-foreground); }
    .agent-instructions h5 { font-size: 13px; margin: 8px 0 4px; color: var(--vscode-descriptionForeground); }
    .agent-instructions p { margin: 4px 0; }
    .agent-instructions ul { margin: 4px 0 4px 16px; padding: 0; }
    .agent-instructions li { margin: 2px 0; }
    .agent-instructions pre.spec-code {
      background: var(--vscode-textCodeBlock-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 8px 12px;
      margin: 6px 0;
      overflow-x: auto;
      font-size: 12px;
    }
    .agent-instructions code.inline-code {
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 3px;
      font-size: 12px;
    }
    .agent-instructions strong { color: var(--vscode-foreground); }
    .spec-meta { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--vscode-panel-border); }
    .spec-meta .spec-field { font-size: 11px; margin: 2px 0; }
    .spec-meta .spec-label { color: var(--vscode-descriptionForeground); }
    
    /* Code content area */
    .work-code {
      margin: 0;
      padding: 12px 16px;
      background: var(--vscode-editor-background);
      font-family: var(--vscode-editor-font-family), 'Consolas', 'Monaco', monospace;
      font-size: 12px;
      line-height: 1.5;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .work-code code {
      font-family: inherit;
      background: none;
      padding: 0;
    }
    
    /* Agent instructions (markdown content) */
    .work-instructions {
      padding: 12px 16px;
      font-size: 13px;
      line-height: 1.6;
    }
    
    /* Legacy badge styles (keep for backward compat) */
    .work-type-badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      padding: 2px 6px;
      border-radius: 3px;
      margin-bottom: 6px;
    }
    .work-type-badge.agent { background: rgba(99, 179, 237, 0.2); color: #63b3ed; }
    .work-type-badge.shell { background: rgba(72, 187, 120, 0.2); color: #48bb78; }
    .work-type-badge.process { background: rgba(237, 137, 54, 0.2); color: #ed8936; }
    .work-instructions p, .work-instructions .md-para {
      margin: 0 0 8px 0;
    }
    .work-instructions p:last-child, .work-instructions .md-para:last-child {
      margin-bottom: 0;
    }
    
    /* Markdown rendering styles */
    .md-list {
      margin: 8px 0;
      padding-left: 24px;
    }
    .md-list li {
      margin-bottom: 6px;
      line-height: 1.5;
    }
    .md-list li:last-child {
      margin-bottom: 0;
    }
    .md-header {
      margin: 12px 0 8px 0;
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    h3.md-header { font-size: 15px; }
    h4.md-header { font-size: 14px; }
    h5.md-header { font-size: 13px; }
    .md-code-block {
      background: var(--vscode-editor-background);
      padding: 10px 12px;
      border-radius: 4px;
      margin: 8px 0;
      overflow-x: auto;
      font-family: var(--vscode-editor-font-family), monospace;
      font-size: 12px;
    }
    .md-code-block code {
      background: none;
      padding: 0;
    }
    .md-inline-code {
      background: var(--vscode-editor-background);
      padding: 2px 5px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family), monospace;
      font-size: 12px;
    }
    .md-link {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    .md-link:hover {
      text-decoration: underline;
    }
    .work-list {
      margin: 8px 0;
      padding-left: 24px;
    }
    .work-list li {
      margin-bottom: 6px;
      line-height: 1.5;
    }
    .work-list li:last-child {
      margin-bottom: 0;
    }
    .work-bullet {
      margin: 4px 0;
      padding-left: 8px;
    }
    
    /* Error */
    .error-box {
      background: rgba(244, 135, 113, 0.1);
      border: 1px solid rgba(244, 135, 113, 0.3);
      border-radius: 6px;
      padding: 10px;
      margin-top: 12px;
      color: #f48771;
    }
    .error-message {
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--vscode-editor-font-family), monospace;
      font-size: 12px;
      line-height: 1.5;
      display: block;
      margin-top: 4px;
    }
    .error-message.crashed {
      background: rgba(255, 100, 0, 0.1);
      border: 1px solid rgba(255, 100, 0, 0.3);
      border-radius: 4px;
      padding: 4px 8px;
      color: #ff6400;
      font-weight: 500;
    }
    .error-phase {
      margin-top: 6px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    
    /* Session ID */
    .session-id {
      cursor: pointer;
      font-family: var(--vscode-editor-font-family), monospace;
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 6px;
      border-radius: 4px;
    }
    .session-id:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .meta-item.full-width {
      grid-column: 1 / -1;
    }
    
    /* Retry Buttons */
    .retry-section {
      display: flex;
      gap: 8px;
      margin-top: 12px;
      flex-wrap: wrap;
    }
    .retry-btn {
      padding: 8px 16px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .retry-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .retry-btn.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .retry-btn.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    
    /* Phase Tabs */
    .phase-tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    .phase-tab {
      padding: 6px 12px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .phase-tab:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .phase-tab.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .phase-icon { font-size: 11px; }
    .phase-tab.phase-success .phase-icon { color: #4ec9b0; }
    .phase-tab.phase-failed .phase-icon { color: #f48771; }
    .phase-tab.phase-running .phase-icon { color: #3794ff; animation: pulse-phase 1.2s infinite; }
    .phase-tab.active.phase-running .phase-icon { color: #ffffff; animation: pulse-phase-active 1.2s infinite; }
    @keyframes pulse-phase { 50% { opacity: 0.4; } }
    @keyframes pulse-phase-active { 0%, 100% { opacity: 1; text-shadow: 0 0 6px rgba(255,255,255,0.8); } 50% { opacity: 0.5; text-shadow: none; } }
    
    /* Log File Path */
    .log-file-path {
      font-family: 'Consolas', 'Courier New', monospace;
      font-size: 11px;
      padding: 6px 10px;
      margin-bottom: 4px;
      background: var(--vscode-textBlockQuote-background);
      border-radius: 4px;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100%;
      display: block;
      box-sizing: border-box;
    }
    .log-file-path:hover {
      text-decoration: underline;
      background: var(--vscode-textBlockQuote-border);
    }
    
    /* Log Viewer */
    .log-viewer {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 6px;
      max-height: 300px;
      overflow: auto;
    }
    .log-placeholder, .log-loading {
      padding: 20px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
    .log-content {
      margin: 0;
      padding: 12px;
      font-family: 'Consolas', 'Courier New', monospace;
      font-size: 12px;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
      user-select: text;
      -webkit-user-select: text;
      cursor: text;
    }
    .log-viewer:focus-within {
      outline: 1px solid var(--vscode-focusBorder);
    }
    
    /* Dependencies */
    .deps-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .dep-badge {
      padding: 3px 10px;
      border-radius: 12px;
      font-size: 11px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .dep-badge.succeeded { background: rgba(78, 201, 176, 0.2); color: #4ec9b0; }
    .dep-badge.failed { background: rgba(244, 135, 113, 0.2); color: #f48771; }
    .dep-badge.running { background: rgba(0, 122, 204, 0.2); color: #3794ff; }
    
    /* Work Summary */
    .work-summary-stats {
      display: flex;
      gap: 16px;
    }
    .work-stat {
      text-align: center;
      padding: 8px 16px;
      background: var(--vscode-editor-background);
      border-radius: 6px;
    }
    .work-stat-value {
      font-size: 18px;
      font-weight: 600;
    }
    .work-stat-label {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
    }
    .work-stat.added .work-stat-value { color: #4ec9b0; }
    .work-stat.modified .work-stat-value { color: #dcdcaa; }
    .work-stat.deleted .work-stat-value { color: #f48771; }
    .work-summary-desc {
      margin-top: 12px;
      font-style: italic;
      color: var(--vscode-descriptionForeground);
    }
    
    /* Aggregated Work Summary */
    .work-summary-section.aggregated {
      border-top: 1px solid var(--vscode-panel-border);
      margin-top: 16px;
      padding-top: 16px;
      opacity: 0.9;
    }
    .work-summary-section.aggregated h4 {
      color: var(--vscode-descriptionForeground);
      font-weight: normal;
      font-size: 14px;
      margin-bottom: 12px;
    }
    .work-summary-stats.aggregated-stats {
      opacity: 0.95;
    }
    
    /* Commit Details */
    .commits-list {
      margin-top: 16px;
      border-top: 1px solid var(--vscode-panel-border);
      padding-top: 12px;
    }
    .commit-item {
      padding: 8px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .commit-item:last-child {
      border-bottom: none;
    }
    .commit-hash {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 12px;
      color: #dcdcaa;
    }
    .commit-message {
      margin-left: 8px;
      font-size: 13px;
    }
    .commit-files {
      margin-top: 8px;
      margin-left: 60px;
      font-size: 11px;
      font-family: var(--vscode-editor-font-family), monospace;
    }
    .file-item {
      padding: 2px 0;
    }
    .file-added { color: #4ec9b0; }
    .file-modified { color: #dcdcaa; }
    .file-deleted { color: #f48771; }
    
    /* Process Tree */
    .process-tree-section {
      border-left: 3px solid var(--vscode-progressBar-background);
    }
    .process-tree-header {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      user-select: none;
      margin-bottom: 12px;
    }
    .process-tree-header:hover { opacity: 0.8; }
    .process-tree-chevron {
      font-size: 10px;
      transition: transform 0.2s;
      opacity: 0.7;
    }
    .process-tree-icon { font-size: 16px; }
    .process-tree-title {
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.8;
    }
    .process-tree {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 300px;
      overflow-y: auto;
    }
    .process-loading {
      padding: 12px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    .agent-work-indicator {
      padding: 12px 16px;
      background: rgba(99, 179, 237, 0.1);
      border: 1px solid rgba(99, 179, 237, 0.3);
      border-radius: 6px;
      color: #63b3ed;
      display: flex;
      align-items: center;
      gap: 8px;
      animation: pulse 2s ease-in-out infinite;
    }
    .agent-icon {
      font-size: 18px;
    }
    .agent-duration {
      opacity: 0.7;
      font-size: 12px;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }
    .process-node {
      background: var(--vscode-editor-background);
      border-radius: 4px;
      padding: 8px 10px;
      border-left: 2px solid var(--vscode-progressBar-background);
    }
    .process-node-header {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .process-node-icon { font-size: 14px; }
    .process-node-name {
      font-weight: 600;
      font-size: 12px;
      color: var(--vscode-foreground);
    }
    .process-node-pid {
      font-size: 10px;
      opacity: 0.6;
      font-family: monospace;
    }
    .process-node-stats {
      display: flex;
      gap: 12px;
      margin-top: 4px;
      padding-left: 22px;
    }
    .process-stat {
      font-size: 11px;
      font-family: monospace;
      color: var(--vscode-descriptionForeground);
    }
    .process-node-cmdline {
      font-size: 10px;
      opacity: 0.5;
      font-family: monospace;
      margin-top: 4px;
      padding-left: 22px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    /* Actions */
    .actions {
      margin-top: 16px;
      display: flex;
      gap: 8px;
    }
    .action-btn {
      padding: 6px 14px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .action-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    
    /* Attempt History Cards */
    .attempt-card {
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      margin-bottom: 10px;
      overflow: hidden;
    }
    .attempt-card.active {
      border-color: var(--vscode-progressBar-background);
      border-width: 2px;
    }
    .attempt-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 14px;
      cursor: pointer;
      user-select: none;
    }
    .attempt-header:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .attempt-header-left {
      display: flex;
      gap: 10px;
      align-items: center;
      flex: 1;
    }
    .attempt-badge {
      font-weight: 700;
      padding: 3px 8px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 4px;
      font-size: 10px;
      min-width: 20px;
      text-align: center;
    }
    .trigger-badge {
      font-size: 10px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
      white-space: nowrap;
    }
    .trigger-badge.auto-heal {
      background: rgba(255, 167, 38, 0.2);
      color: #ffa726;
    }
    .trigger-badge.retry {
      background: rgba(66, 165, 245, 0.2);
      color: #42a5f5;
    }
    .step-indicators {
      display: flex;
      gap: 4px;
    }
    .step-dot, .step-icon { font-size: 14px; }
    .step-dot.success, .step-icon.success { color: var(--vscode-testing-iconPassed); }
    .step-dot.failed, .step-icon.failed { color: var(--vscode-errorForeground); }
    .step-dot.skipped, .step-icon.skipped { color: #808080; }
    .step-dot.pending, .step-icon.pending { color: var(--vscode-descriptionForeground); opacity: 0.5; }
    .step-dot.running, .step-icon.running { color: #7DD3FC; animation: pulse-dot 1.5s ease-in-out infinite; }
    @keyframes pulse-dot {
      0%, 100% { opacity: 0.4; transform: scale(1); }
      50% { opacity: 1; transform: scale(1.2); }
    }
    .attempt-time { font-size: 10px; opacity: 0.7; }
    .attempt-duration { font-size: 10px; opacity: 0.7; }
    .chevron {
      font-size: 12px;
      transition: transform 0.2s;
    }
    .chevron.expanded {
      transform: rotate(90deg);
    }
    .attempt-body {
      padding: 14px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }
    .attempt-meta {
      font-size: 11px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .attempt-meta-row { line-height: 1.6; }
    .attempt-meta-row strong { opacity: 0.7; }
    .status-succeeded { color: #4ec9b0; }
    .status-failed { color: #f48771; }
    .status-canceled { color: #858585; }
    .attempt-error {
      margin-top: 8px;
      padding: 8px;
      background: rgba(244, 135, 113, 0.1);
      border: 1px solid rgba(244, 135, 113, 0.3);
      border-radius: 4px;
      color: #f48771;
      font-size: 11px;
    }
    .attempt-error .error-message {
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--vscode-editor-font-family), monospace;
      font-size: 11px;
      line-height: 1.5;
      display: block;
      margin-top: 4px;
    }
    .attempt-context {
      margin-top: 8px;
      padding: 8px;
      background: var(--vscode-sideBar-background);
      border-radius: 4px;
      font-size: 11px;
      overflow: hidden;
    }
    .attempt-context code {
      background: rgba(255, 255, 255, 0.05);
      padding: 1px 4px;
      border-radius: 2px;
      font-family: var(--vscode-editor-font-family);
      font-size: 10px;
    }
    .attempt-work-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .attempt-work-content {
      margin-top: 4px;
    }
    .attempt-work-content .work-instructions {
      font-size: 11px;
      padding: 8px 12px;
    }
    .attempt-work-content .work-command {
      font-size: 11px;
      padding: 6px 10px;
    }
    /* Attempt phase tabs */
    .attempt-phases {
      margin-top: 8px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      overflow: hidden;
    }
    .attempt-phase-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 2px;
      padding: 4px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .attempt-phase-tab {
      padding: 4px 8px;
      font-size: 10px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 3px;
      color: var(--vscode-foreground);
      cursor: pointer;
      opacity: 0.7;
    }
    .attempt-phase-tab:hover {
      background: var(--vscode-list-hoverBackground);
      opacity: 1;
    }
    .attempt-phase-tab.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      opacity: 1;
    }
    .attempt-phase-tab.success {
      color: #3fb950;
    }
    .attempt-phase-tab.failed {
      color: #f85149;
    }
    .attempt-phase-tab.skipped {
      opacity: 0.5;
    }
    .attempt-phase-tab.active.success,
    .attempt-phase-tab.active.failed,
    .attempt-phase-tab.active.skipped {
      color: var(--vscode-button-foreground);
    }
    .attempt-log-viewer {
      margin: 0;
      padding: 8px;
      background: var(--vscode-editor-background);
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 300px;
      overflow: auto;
    }
    
    /* AI Usage Metrics Card */
    .metrics-card {
      border: 1px solid var(--vscode-progressBar-background);
      background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-progressBar-background));
      border-radius: 8px;
    }
    .metrics-card h3 {
      margin-top: 0;
    }
    .metrics-stats-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px 16px;
      margin-bottom: 12px;
    }
    .metrics-stat {
      font-size: 12px;
      white-space: nowrap;
    }
    .model-breakdown {
      margin-top: 8px;
    }
    .model-breakdown-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
    }
    .model-breakdown-list {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 8px 10px;
    }
    .model-row {
      display: flex;
      gap: 12px;
      align-items: baseline;
      padding: 2px 0;
      font-size: 11px;
      font-family: var(--vscode-editor-font-family), monospace;
    }
    .model-name {
      font-weight: 600;
      min-width: 140px;
    }
    .model-tokens {
      color: var(--vscode-descriptionForeground);
    }
    /* Attempt-level metrics card (matches main metrics card style) */
    .attempt-metrics-card {
      margin-top: 8px;
      padding: 8px 10px;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 80%, var(--vscode-progressBar-background));
      border-radius: 4px;
    }
    .attempt-metrics-card .metrics-stats-grid {
      margin-bottom: 8px;
    }
    .attempt-metrics-card .model-breakdown {
      margin-top: 6px;
    }
    /* Phase breakdown */
    .phase-metrics-breakdown {
      margin-top: 8px;
    }
    .phase-metrics-row {
      display: flex;
      gap: 12px;
      align-items: baseline;
      padding: 2px 0;
      font-size: 11px;
    }
    .phase-metrics-label {
      font-weight: 600;
      min-width: 120px;
      white-space: nowrap;
    }
    .phase-metrics-stats {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    `;
  }
}
