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
import { PlanRunner, PlanInstance, JobNode, NodeExecutionState, JobWorkSummary, WorkSpec, AttemptRecord, CopilotUsageMetrics } from '../../plan';
import { escapeHtml, formatDuration, errorPageHtml, loadingPageHtml, commitDetailsHtml, workSummaryStatsHtml } from '../templates';
import { getNodeMetrics, formatPremiumRequests, formatDurationSeconds, formatTokenCount, formatCodeChanges } from '../../plan/metricsAggregator';

/**
 * Truncate a log file path for display, keeping the drive letter,
 * an ellipsis, and the filename with attempt number visible.
 * Full path is preserved in the title attribute for tooltip.
 *
 * @param filePath - The full log file path.
 * @returns A truncated display string like "C:\...\filename_1.log"
 */
function truncateLogPath(filePath: string): string {
  if (!filePath) return '';
  
  // Get the filename (last part of the path)
  const separator = filePath.includes('\\') ? '\\' : '/';
  const parts = filePath.split(separator);
  const filename = parts[parts.length - 1];
  
  // Get the drive letter or first folder
  const prefix = parts[0] + separator;
  
  // Truncate the filename too if it's a UUID-based log file
  // Pattern: {planId}_{nodeId}_{attempt}.log -> {first8}....{last12}_N.log
  let truncatedFilename = filename;
  const logMatch = filename.match(/^([a-f0-9]{8})-[a-f0-9-]+_[a-f0-9-]+-([a-f0-9]{12})_(\d+\.log)$/i);
  if (logMatch) {
    truncatedFilename = `${logMatch[1]}....${logMatch[2]}_${logMatch[3]}`;
  }
  
  // If the path is short enough, return as-is
  if (filePath.length <= 50) return filePath;
  
  // Truncate the middle
  return `${prefix}....${separator}${truncatedFilename}`;
}

/**
 * Format a {@link WorkSpec} as a plain-text summary string.
 *
 * @param spec - The work specification to format.
 * @returns A human-readable text representation of the work spec, or empty string if undefined.
 */
function formatWorkSpec(spec: WorkSpec | undefined): string {
  if (!spec) return '';
  
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
  if (!shell) return { name: 'Shell', lang: 'shell' };
  const lower = shell.toLowerCase();
  if (lower.includes('powershell')) return { name: 'PowerShell', lang: 'powershell' };
  if (lower.includes('pwsh')) return { name: 'PowerShell', lang: 'powershell' };
  if (lower.includes('bash')) return { name: 'Bash', lang: 'bash' };
  if (lower.includes('zsh')) return { name: 'Zsh', lang: 'bash' };
  if (lower.includes('cmd')) return { name: 'CMD', lang: 'batch' };
  if (lower.includes('sh')) return { name: 'Shell', lang: 'shell' };
  return { name: shell, lang: 'shell' };
}

function formatWorkSpecHtml(spec: WorkSpec | undefined, escapeHtml: (s: string) => string): string {
  if (!spec) return '';
  
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
  if (!cmd || cmd.length < 80) return cmd;
  
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
  private _updateInterval?: NodeJS.Timeout;
  private _currentPhase: string | null = null;
  private _lastStatus: string | null = null;
  private _lastWorktreeCleanedUp: boolean | undefined = undefined;
  
  /**
   * @param panel - The VS Code webview panel instance.
   * @param planId - The Plan ID that contains this node.
   * @param nodeId - The unique identifier of the node to display.
   * @param _planRunner - The {@link PlanRunner} instance for querying state and logs.
   */
  private constructor(
    panel: vscode.WebviewPanel,
    planId: string,
    nodeId: string,
    private _planRunner: PlanRunner
  ) {
    this._panel = panel;
    this._planId = planId;
    this._nodeId = nodeId;
    
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
    
    // Setup update interval for running nodes
    this._updateInterval = setInterval(() => {
      const plan = this._planRunner.get(this._planId);
      const state = plan?.nodeStates.get(this._nodeId);
      if (state?.status === 'running' || state?.status === 'scheduled') {
        // Status changed - do full update
        if (this._lastStatus !== state.status) {
          this._lastStatus = state.status;
          this._update();
        } else if (this._currentPhase) {
          // Just refresh the current log view
          this._sendLog(this._currentPhase);
        }
      } else if (this._lastStatus === 'running' || this._lastStatus === 'scheduled') {
        // Transitioned from running to terminal - do full update
        this._lastStatus = state?.status || null;
        this._update();
        // Send final log update
        if (this._currentPhase) {
          setTimeout(() => this._sendLog(this._currentPhase!), 100);
        }
      } else {
        // Terminal state - check for worktree cleanup or other state changes
        if (state?.worktreeCleanedUp !== this._lastWorktreeCleanedUp) {
          this._lastWorktreeCleanedUp = state?.worktreeCleanedUp;
          this._update();
        }
      }
    }, 500);
    
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
    planRunner: PlanRunner
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
    
    const nodePanel = new NodeDetailPanel(panel, planId, nodeId, planRunner);
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
    
    if (this._updateInterval) {
      clearInterval(this._updateInterval);
    }
    
    this._panel.dispose();
    
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
    }
  }
  
  /**
   * Handle incoming messages from the webview.
   *
   * @param message - The message object received from the webview's `postMessage`.
   */
  private _handleMessage(message: any) {
    switch (message.type) {
      case 'openPlan':
        vscode.commands.executeCommand('orchestrator.showPlanDetails', message.planId);
        break;
      case 'openWorktree':
        const plan = this._planRunner.get(this._planId);
        const state = plan?.nodeStates.get(this._nodeId);
        if (state?.worktreePath) {
          vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(state.worktreePath), { forceNewWindow: true });
        }
        break;
      case 'refresh':
        this._update();
        break;
      case 'getLog':
        this._currentPhase = message.phase;
        this._sendLog(message.phase);
        break;
      case 'getProcessStats':
        this._sendProcessStats();
        break;
      case 'copyToClipboard':
        if (message.text) {
          vscode.env.clipboard.writeText(message.text);
          vscode.window.showInformationMessage('Copied to clipboard');
        }
        break;
      case 'retryNode':
        this._retryNode(message.planId, message.nodeId, message.resumeSession).catch(err => {
          vscode.window.showErrorMessage(`Retry failed: ${err?.message || err}`);
        });
        break;
      case 'confirmForceFailNode':
        // Show VS Code native confirmation dialog (browser confirm() doesn't work in webviews)
        vscode.window.showWarningMessage(
          'Force-fail this node? This will mark it as failed and may affect downstream nodes.',
          { modal: true },
          'Force Fail'
        ).then(choice => {
          if (choice === 'Force Fail') {
            this._forceFailNode(message.planId || this._planId, message.nodeId || this._nodeId).catch(err => {
              vscode.window.showErrorMessage(`Force fail failed: ${err?.message || err}`);
            });
          }
        });
        break;
      case 'forceFailNode':
        // Direct force fail without confirmation (for programmatic use)
        this._forceFailNode(message.planId || this._planId, message.nodeId || this._nodeId).catch(err => {
          vscode.window.showErrorMessage(`Force fail failed: ${err?.message || err}`);
        });
        break;
      case 'openLogFile':
        if (message.path && path.isAbsolute(message.path) && fs.existsSync(message.path)) {
          vscode.commands.executeCommand('vscode.open', vscode.Uri.file(message.path));
        }
        break;
    }
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
    const attemptHistoryHtml = (state.attemptHistory && state.attemptHistory.length > 0)
      ? this._buildAttemptHistoryHtml(state)
      : '';

    // Compute aggregated metrics across all attempts
    const nodeMetrics = getNodeMetrics(state);
    const nodeMetricsHtml = nodeMetrics ? this._buildMetricsSummaryHtml(nodeMetrics, state.phaseMetrics) : '';

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
  <div class="breadcrumb">
    <a onclick="openPlan('${plan.id}')">${escapeHtml(plan.spec.name)}</a> / ${escapeHtml(node.name)}
  </div>
  
  <div class="header">
    <h2>${escapeHtml(node.name)}</h2>
    <span class="status-badge ${state.status}">${state.status.toUpperCase()}</span>
  </div>
  
  <!-- Execution State -->
  <div class="section">
    <h3>Execution State</h3>
    <div class="meta-grid">
      <div class="meta-item">
        <div class="meta-label">Type</div>
        <div class="meta-value">${node.type === 'job' ? 'Job' : 'sub-plan'}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Attempts</div>
        <div class="meta-value">${state.attempts}${state.attempts > 1 ? ' ⟳' : ''}</div>
      </div>
      ${state.startedAt ? `
      <div class="meta-item">
        <div class="meta-label">Started</div>
        <div class="meta-value">${new Date(state.startedAt).toLocaleString()}</div>
      </div>
      ` : ''}
      ${duration ? `
      <div class="meta-item">
        <div class="meta-label">Duration</div>
        <div class="meta-value" id="duration-timer"${!state.endedAt && state.startedAt ? ` data-started-at="${state.startedAt}"` : ''}>${duration}</div>
      </div>
      ` : ''}
      ${state.copilotSessionId ? `
      <div class="meta-item full-width">
        <div class="meta-label">Copilot Session</div>
        <div class="meta-value session-id" data-session="${state.copilotSessionId}" title="Click to copy">
          ${state.copilotSessionId.substring(0, 12)}... 📋
        </div>
      </div>
      ` : ''}
    </div>
    ${state.error ? `
    <div class="error-box">
      <strong>${state.failureReason === 'crashed' ? 'Crashed:' : 'Error:'}</strong> 
      <span class="error-message ${state.failureReason === 'crashed' ? 'crashed' : ''}">${escapeHtml(state.error)}</span>
      ${state.lastAttempt?.phase ? `<div class="error-phase">Failed in phase: <strong>${state.lastAttempt.phase}</strong></div>` : ''}
      ${state.lastAttempt?.exitCode !== undefined ? `<div class="error-phase">Exit code: <strong>${state.lastAttempt.exitCode}</strong></div>` : ''}
    </div>
    ` : ''}
    ${state.status === 'failed' ? `
    <div class="retry-section">
      <button class="retry-btn" data-action="retry-node" data-plan-id="${plan.id}" data-node-id="${node.id}">
        🔄 Retry Node
      </button>
      <button class="retry-btn secondary" data-action="retry-node-fresh" data-plan-id="${plan.id}" data-node-id="${node.id}">
        🆕 Retry (Fresh Session)
      </button>
    </div>
    ` : ''}
    ${state.status === 'running' ? `
    <div class="force-fail-section">
      <p style="color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 8px;">
        If the process has crashed or is stuck, you can force fail this node to enable retry.
      </p>
      <button class="retry-btn secondary" data-action="force-fail-node" data-plan-id="${plan.id}" data-node-id="${node.id}">
        ⚠️ Force Fail (Enable Retry)
      </button>
    </div>
    ` : ''}
  </div>
  
  ${(state.status === 'running' || state.status === 'scheduled') ? `
  <!-- Process Tree (only for running jobs) -->
  <div class="section process-tree-section" id="processTreeSection">
    <div class="process-tree-header" data-expanded="true">
      <span class="process-tree-chevron">▼</span>
      <span class="process-tree-icon">⚡</span>
      <span class="process-tree-title" id="processTreeTitle">Running Processes</span>
    </div>
    <div class="process-tree" id="processTree">
      <div class="process-loading">Loading process tree...</div>
    </div>
  </div>
  ` : ''}
  
  ${nodeMetricsHtml}
  
  <!-- Job Configuration -->
  <div class="section">
    <h3>Job Configuration</h3>
    <div class="config-item">
      <div class="config-label">Task</div>
      <div class="config-value">${escapeHtml(node.task)}</div>
    </div>
    ${node.work ? `
    <div class="config-item work-item">
      <div class="config-label">Work</div>
      <div class="config-value work-content">${formatWorkSpecHtml(node.work, escapeHtml)}</div>
    </div>
    ` : ''}
    ${node.instructions ? `
    <div class="config-item">
      <div class="config-label">Instructions</div>
      <div class="config-value">${escapeHtml(node.instructions)}</div>
    </div>
    ` : ''}
  </div>
  
  <!-- Phase Progress -->
  <div class="section">
    <h3>Execution Phases</h3>
    <div class="phase-tabs">
      ${this._buildPhaseTabs(phaseStatus, state.status === 'running')}
    </div>
    ${logFilePath ? `<div class="log-file-path" id="logFilePath" data-path="${escapeHtml(logFilePath)}" title="${escapeHtml(logFilePath)}">📄 ${escapeHtml(truncateLogPath(logFilePath))}</div>` : ''}
    <div class="log-viewer" id="logViewer">
      <div class="log-placeholder">Select a phase tab to view logs</div>
    </div>
  </div>
  
  ${workSummaryHtml}
  
  <!-- Dependencies -->
  <div class="section">
    <h3>Dependencies</h3>
    ${node.dependencies.length > 0 ? `
    <div class="deps-list">
      ${node.dependencies.map(depId => {
        const depNode = plan.nodes.get(depId);
        const depState = plan.nodeStates.get(depId);
        return `<span class="dep-badge ${depState?.status || 'pending'}">${escapeHtml(depNode?.name || depId)}</span>`;
      }).join('')}
    </div>
    ` : '<div class="config-value">No dependencies (root node)</div>'}
  </div>
  
  <!-- Attempt History -->
  ${attemptHistoryHtml}
  
  <!-- Git Information -->
  ${state.worktreePath || state.baseCommit || state.completedCommit ? `
  <div class="section">
    <h3>Git Information</h3>
    <div class="meta-grid">
      ${state.baseCommit ? `
      <div class="meta-item">
        <div class="meta-label">Base Commit</div>
        <div class="meta-value mono">${state.baseCommit.slice(0, 12)}</div>
      </div>
      ` : ''}
      ${state.completedCommit ? `
      <div class="meta-item">
        <div class="meta-label">Completed Commit</div>
        <div class="meta-value mono">${state.completedCommit.slice(0, 12)}</div>
      </div>
      ` : ''}
    </div>
    ${state.worktreePath ? `
    <div class="config-item">
      <div class="config-label">Worktree${state.worktreeCleanedUp ? ' (cleaned up)' : ' (detached HEAD)'}</div>
      <div class="config-value mono" style="${state.worktreeCleanedUp ? 'text-decoration: line-through; opacity: 0.6;' : ''}">${escapeHtml(state.worktreePath)}</div>
    </div>
    ` : ''}
  </div>
  ` : ''}
  
  <!-- Actions -->
  <div class="actions">
    ${state.worktreePath && !state.worktreeCleanedUp ? '<button class="action-btn" onclick="openWorktree()">Open Worktree</button>' : ''}
    <button class="action-btn" onclick="refresh()">Refresh</button>
  </div>
  
  <script>
    const vscode = acquireVsCodeApi();
    const PLAN_ID = ${JSON.stringify(plan.id)};
    const NODE_ID = ${JSON.stringify(node.id)};
    let currentPhase = ${this._currentPhase ? JSON.stringify(this._currentPhase) : 'null'};
    const initialPhase = ${initialPhase ? JSON.stringify(initialPhase) : 'null'};
    
    // Global Ctrl+C handler for copying selected text in webview
    document.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        const selectedText = window.getSelection().toString();
        if (selectedText) {
          e.preventDefault();
          vscode.postMessage({ type: 'copyToClipboard', text: selectedText });
        }
      }
    });
    
    // Auto-select a phase on load: restore previous selection, or use initial phase
    const phaseToSelect = currentPhase || initialPhase;
    if (phaseToSelect) {
      setTimeout(() => selectPhase(phaseToSelect), 50);
    }
    
    function openPlan(planId) {
      vscode.postMessage({ type: 'openPlan', planId });
    }
    
    function openWorktree() {
      vscode.postMessage({ type: 'openWorktree' });
    }
    
    function refresh() {
      vscode.postMessage({ type: 'refresh' });
    }
    
    // Session ID copy handler - using event delegation for dynamic content
    document.body.addEventListener('click', (e) => {
      if (!(e.target instanceof Element)) return;
      const target = e.target.closest('.session-id');
      if (target) {
        const sessionId = target.getAttribute('data-session');
        vscode.postMessage({ type: 'copyToClipboard', text: sessionId });
      }
    });
    
    // Log file path click handler - using event delegation
    document.body.addEventListener('click', (e) => {
      if (!(e.target instanceof Element)) return;
      const target = e.target.closest('.log-file-path');
      if (target) {
        const path = target.getAttribute('data-path');
        if (path) {
          vscode.postMessage({ type: 'openLogFile', path });
        }
      }
    });
    
    // Retry button handlers - using event delegation for dynamic content
    document.body.addEventListener('click', (e) => {
      if (!(e.target instanceof Element)) return;
      const btn = e.target.closest('.retry-btn');
      if (!btn) return;
      
      const action = btn.getAttribute('data-action');
      // Use global constants for planId/nodeId - more reliable than data attributes
      const planId = PLAN_ID;
      const nodeId = NODE_ID;
      
      if (action === 'retry-node') {
        vscode.postMessage({ type: 'retryNode', planId, nodeId, resumeSession: true });
      } else if (action === 'retry-node-fresh') {
        vscode.postMessage({ type: 'retryNode', planId, nodeId, resumeSession: false });
      } else if (action === 'force-fail-node') {
        // Request confirmation from extension (browser confirm() doesn't work in webviews)
        vscode.postMessage({ type: 'confirmForceFailNode', planId, nodeId });
      }
    });
    
    // Attempt card toggle handlers - using event delegation
    document.body.addEventListener('click', (e) => {
      if (!(e.target instanceof Element)) return;
      const header = e.target.closest('.attempt-header');
      if (!header) return;
      
      const card = header.closest('.attempt-card');
      const body = card.querySelector('.attempt-body');
      const chevron = header.querySelector('.chevron');
      const isExpanded = header.getAttribute('data-expanded') === 'true';
      
      if (isExpanded) {
        body.style.display = 'none';
        chevron.classList.remove('expanded');
        chevron.textContent = '▶';
        header.setAttribute('data-expanded', 'false');
      } else {
        body.style.display = 'block';
        chevron.classList.add('expanded');
        chevron.textContent = '▼';
        header.setAttribute('data-expanded', 'true');
      }
    });
    
    // Attempt phase tab click handlers - using event delegation
    document.body.addEventListener('click', (e) => {
      const tab = e.target.closest('.attempt-phase-tab');
      if (!tab) return;
      
      e.stopPropagation();
      const phase = tab.getAttribute('data-phase');
      const attemptNum = tab.getAttribute('data-attempt');
      const phasesContainer = tab.closest('.attempt-phases');
      
      // Update active tab
      phasesContainer.querySelectorAll('.attempt-phase-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      // Get logs data from the JSON script element
      const dataEl = phasesContainer.querySelector('.attempt-logs-data[data-attempt="' + attemptNum + '"]');
      if (dataEl) {
        try {
          const logsData = JSON.parse(dataEl.textContent);
          const viewer = phasesContainer.querySelector('.attempt-log-viewer[data-attempt="' + attemptNum + '"]');
          if (viewer && logsData[phase]) {
            viewer.textContent = logsData[phase];
          }
        } catch (err) {
          console.error('Failed to parse attempt logs data:', err);
        }
      }
    });
    
    function selectPhase(phase) {
      currentPhase = phase;
      
      // Update tab selection
      document.querySelectorAll('.phase-tab').forEach(t => t.classList.remove('active'));
      document.querySelector('[data-phase="' + phase + '"]').classList.add('active');
      
      // Show loading state
      document.getElementById('logViewer').innerHTML = '<div class="log-loading">Loading logs...</div>';
      
      // Request log content
      vscode.postMessage({ type: 'getLog', phase });
    }
    
    // Handle log content messages
    // Track last log content to avoid unnecessary updates
    let lastLogContent = '';
    
    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'logContent' && msg.phase === currentPhase) {
        const viewer = document.getElementById('logViewer');
        
        // Skip update if content hasn't changed
        if (msg.content === lastLogContent) {
          return;
        }
        
        // Skip update if user has text selected (don't disrupt their selection)
        const selection = window.getSelection();
        if (selection && selection.toString().length > 0) {
          // User has selection - defer update (will get it on next refresh when they deselect)
          return;
        }
        
        lastLogContent = msg.content;
        
        // Check if user was at bottom before updating content
        // Allow some tolerance (50px) for "at bottom" detection
        const wasAtBottom = viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < 50;
        
        viewer.innerHTML = '<pre class="log-content" tabindex="0">' + escapeHtml(msg.content) + '</pre>';
        
        // Only auto-scroll if user was already at bottom (respect manual scrolling)
        if (wasAtBottom) {
          viewer.scrollTop = viewer.scrollHeight;
        }
        
        // Setup log viewer keyboard shortcuts
        const logContent = viewer.querySelector('.log-content');
        if (logContent) {
          logContent.addEventListener('click', () => logContent.focus());
          logContent.addEventListener('keydown', function(e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
              e.preventDefault();
              e.stopPropagation();
              const selection = window.getSelection();
              const range = document.createRange();
              range.selectNodeContents(logContent);
              selection.removeAllRanges();
              selection.addRange(range);
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              window.getSelection().removeAllRanges();
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
              const selectedText = window.getSelection().toString();
              if (selectedText) {
                e.preventDefault();
                vscode.postMessage({ type: 'copyToClipboard', text: selectedText });
              }
            }
          });
        }
      }
      
      // Handle process stats messages
      if (msg.type === 'processStats') {
        renderProcessTree(msg);
      }
    });
    
    // Process tree rendering
    let lastKnownTree = [];
    
    function renderProcessTree(stats) {
      const treeEl = document.getElementById('processTree');
      const titleEl = document.getElementById('processTreeTitle');
      if (!treeEl || !titleEl) return;
      
      // Handle agent work without a process (waiting for CLI to start)
      if (stats.isAgentWork && !stats.pid && stats.running) {
        const duration = stats.duration ? formatDuration(stats.duration) : '';
        treeEl.innerHTML = '<div class="agent-work-indicator"><span class="agent-icon">🤖</span> Copilot Agent starting...' + (duration ? ' <span class="agent-duration">(' + duration + ')</span>' : '') + '</div>';
        titleEl.innerHTML = 'Agent Work <span style="opacity: 0.7; font-weight: normal;">(starting)</span>';
        return;
      }
      
      if (!stats.pid || !stats.running) {
        if (lastKnownTree.length === 0) {
          treeEl.innerHTML = '<div class="process-loading">No active process</div>';
          titleEl.textContent = 'Processes';
        }
        return;
      }
      
      const tree = stats.tree || [];
      lastKnownTree = tree;
      
      // Add agent indicator to title if this is agent work
      const agentPrefix = stats.isAgentWork ? '🤖 ' : '';
      
      if (tree.length === 0) {
        treeEl.innerHTML = '<div class="process-loading">' + agentPrefix + 'Process running (PID ' + stats.pid + ')</div>';
        titleEl.innerHTML = (stats.isAgentWork ? 'Copilot Agent' : 'Processes') + ' <span style="opacity: 0.7; font-weight: normal;">PID ' + stats.pid + '</span>';
        return;
      }
      
      // Count processes and sum stats
      function countAndSum(proc) {
        let count = 1;
        let cpu = proc.cpu || 0;
        let memory = proc.memory || 0;
        if (proc.children) {
          for (const child of proc.children) {
            const childStats = countAndSum(child);
            count += childStats.count;
            cpu += childStats.cpu;
            memory += childStats.memory;
          }
        }
        return { count, cpu, memory };
      }
      
      const totals = tree.reduce((acc, proc) => {
        const s = countAndSum(proc);
        return { count: acc.count + s.count, cpu: acc.cpu + s.cpu, memory: acc.memory + s.memory };
      }, { count: 0, cpu: 0, memory: 0 });
      
      const memMB = (totals.memory / 1024 / 1024).toFixed(1);
      const titleLabel = stats.isAgentWork ? 'Copilot Agent' : 'Processes';
      titleEl.innerHTML = titleLabel + ' <span style="opacity: 0.7; font-weight: normal;">(' + totals.count + ' • ' + totals.cpu.toFixed(0) + '% CPU • ' + memMB + ' MB)</span>';
      
      // Render process nodes
      function renderNode(proc, depth) {
        const memMB = ((proc.memory || 0) / 1024 / 1024).toFixed(1);
        const cpuPct = (proc.cpu || 0).toFixed(0);
        const indent = depth * 16;
        const arrow = depth > 0 ? '↳ ' : '';
        
        let html = '<div class="process-node" style="margin-left: ' + indent + 'px;">';
        html += '<div class="process-node-header">';
        html += '<span class="process-node-icon">⚙️</span>';
        html += '<span class="process-node-name">' + arrow + escapeHtml(proc.name) + '</span>';
        html += '<span class="process-node-pid">PID ' + proc.pid + '</span>';
        html += '</div>';
        html += '<div class="process-node-stats">';
        html += '<span class="process-stat">CPU: ' + cpuPct + '%</span>';
        html += '<span class="process-stat">Mem: ' + memMB + ' MB</span>';
        html += '</div>';
        if (proc.commandLine) {
          html += '<div class="process-node-cmdline">' + escapeHtml(proc.commandLine) + '</div>';
        }
        html += '</div>';
        
        if (proc.children) {
          for (const child of proc.children) {
            html += renderNode(child, depth + 1);
          }
        }
        
        return html;
      }
      
      treeEl.innerHTML = tree.map(p => renderNode(p, 0)).join('');
    }
    
    function formatDuration(ms) {
      const sec = Math.floor(ms / 1000);
      if (sec < 60) return sec + 's';
      const min = Math.floor(sec / 60);
      const remSec = sec % 60;
      return min + 'm ' + remSec + 's';
    }
    
    // Poll for process stats if running
    const processTreeSection = document.getElementById('processTreeSection');
    if (processTreeSection) {
      vscode.postMessage({ type: 'getProcessStats' });
      setInterval(() => {
        vscode.postMessage({ type: 'getProcessStats' });
      }, 1000);
    }

    // Live duration timer for running jobs
    const durationTimer = document.getElementById('duration-timer');
    if (durationTimer && durationTimer.hasAttribute('data-started-at')) {
      const startedAt = parseInt(durationTimer.getAttribute('data-started-at'), 10);
      const nodeStatus = ${JSON.stringify(state.status)};
      
      // Clear any existing timer to prevent duplicates
      if (window.nodeDurationTimer) {
        clearInterval(window.nodeDurationTimer);
      }
      
      // Only run timer if node is running
      if (nodeStatus === 'running' && startedAt) {
        window.nodeDurationTimer = setInterval(() => {
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          const elem = document.getElementById('duration-timer');
          if (elem) {
            elem.textContent = formatDuration(elapsed * 1000);
          }
        }, 1000);
      }
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
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
   * Build HTML for the execution phase tab bar.
   *
   * Each tab shows a phase icon and label, with the active phase highlighted.
   * Clicking a tab sends a `getLog` message to load that phase's logs.
   *
   * @param phaseStatus - Phase-to-status mapping from {@link _getPhaseStatus}.
   * @param isRunning - Whether the node is currently running (affects tab styling).
   * @returns HTML fragment string for the tab bar.
   */
  private _buildPhaseTabs(phaseStatus: Record<string, string>, isRunning: boolean): string {
    const phases = [
      { id: 'all', name: 'Full Log', icon: '📋' },
      { id: 'merge-fi', name: 'Merge FI', icon: this._getMergeIcon(phaseStatus['merge-fi'], '↓') },
      { id: 'prechecks', name: 'Prechecks', icon: this._getPhaseIcon(phaseStatus.prechecks) },
      { id: 'work', name: 'Work', icon: this._getPhaseIcon(phaseStatus.work) },
      { id: 'commit', name: 'Commit', icon: this._getPhaseIcon(phaseStatus.commit) },
      { id: 'postchecks', name: 'Postchecks', icon: this._getPhaseIcon(phaseStatus.postchecks) },
      { id: 'merge-ri', name: 'Merge RI', icon: this._getMergeIcon(phaseStatus['merge-ri'], '↑') },
    ];
    
    return phases.map(p => `
      <button class="phase-tab phase-${phaseStatus[p.id] || 'pending'}" 
              data-phase="${p.id}" 
              onclick="selectPhase('${p.id}')">
        <span class="phase-icon">${p.icon}</span>
        ${p.name}
      </button>
    `).join('');
  }
  
  /**
   * Map a phase status to a Unicode icon character.
   *
   * @param status - The phase status string.
   * @returns A single Unicode icon character.
   */
  private _getPhaseIcon(status: string): string {
    switch (status) {
      case 'success': return '✓';
      case 'failed': return '✗';
      case 'running': return '⟳';
      case 'skipped': return '⊘';
      default: return '○';
    }
  }
  
  /**
   * Map a merge status to a directional merge icon.
   *
   * @param status - The merge phase status string.
   * @param arrow - Direction indicator (`'→'` for forward-integrate, `'←'` for reverse-integrate).
   * @returns A styled merge icon string.
   */
  private _getMergeIcon(status: string, arrow: string): string {
    switch (status) {
      case 'success': return `✓${arrow}`;
      case 'failed': return `✗${arrow}`;
      case 'running': return `⟳${arrow}`;
      case 'skipped': return `○${arrow}`;
      default: return `○${arrow}`;
    }
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
   * Build attempt history HTML with collapsible cards.
   *
   * Renders a reverse-chronological list of past execution attempts,
   * each showing duration, status, error (if any), and phase-level log tabs.
   *
   * @param state - The node execution state containing `attemptHistory`.
   * @returns HTML fragment string, or empty string if there are no past attempts.
   */
  private _buildAttemptHistoryHtml(state: NodeExecutionState): string {
    const attempts = state.attemptHistory;
    if (!attempts || attempts.length === 0) {
      return '';
    }
    
    // Build cards in reverse order (latest first)
    const cards = attempts.slice().reverse().map((attempt, _reverseIdx) => {
      // All attempt cards start collapsed
      const duration = formatDuration(Math.round((attempt.endedAt - attempt.startedAt) / 1000));
      const timestamp = new Date(attempt.startedAt).toLocaleString();
      
      // Step indicators - use same icons as main execution section
      const stepIcon = (status?: string): string => {
        const icon = status === 'success' ? '✓' 
          : status === 'failed' ? '✗'
          : status === 'running' ? '⟳'
          : status === 'skipped' ? '⊘'
          : '○';
        return `<span class="step-icon ${status || 'pending'}">${icon}</span>`;
      };
      
      const stepIndicators = `
        ${stepIcon(attempt.stepStatuses?.['merge-fi'])}
        ${stepIcon(attempt.stepStatuses?.prechecks)}
        ${stepIcon(attempt.stepStatuses?.work)}
        ${stepIcon(attempt.stepStatuses?.commit)}
        ${stepIcon(attempt.stepStatuses?.postchecks)}
        ${stepIcon(attempt.stepStatuses?.['merge-ri'])}
      `;
      
      const sessionHtml = attempt.copilotSessionId
        ? `<div class="attempt-meta-row"><strong>Session:</strong> <span class="session-id" data-session="${attempt.copilotSessionId}" title="Click to copy">${attempt.copilotSessionId.substring(0, 12)}... 📋</span></div>`
        : '';
      
      const errorHtml = attempt.error
        ? `<div class="attempt-error">
            <strong>Error:</strong> <span class="error-message">${escapeHtml(attempt.error)}</span>
            ${attempt.failedPhase ? `<div style="margin-top: 4px;">Failed in phase: <strong>${attempt.failedPhase}</strong></div>` : ''}
            ${attempt.exitCode !== undefined ? `<div>Exit code: <strong>${attempt.exitCode}</strong></div>` : ''}
           </div>`
        : '';
      
      // Context details (worktree, base commit, work used, log file)
      const attemptLogFileHtml = attempt.logFilePath 
        ? `<div class="attempt-meta-row"><strong>Log:</strong> <span class="log-file-path" data-path="${escapeHtml(attempt.logFilePath)}" title="${escapeHtml(attempt.logFilePath)}">📄 ${escapeHtml(truncateLogPath(attempt.logFilePath))}</span></div>`
        : '';
      
      const contextHtml = (attempt.worktreePath || attempt.baseCommit || attempt.workUsed || attempt.logFilePath) 
        ? `<div class="attempt-context">
            ${attempt.baseCommit ? `<div class="attempt-meta-row"><strong>Base:</strong> <code>${attempt.baseCommit.slice(0, 8)}</code></div>` : ''}
            ${attempt.worktreePath ? `<div class="attempt-meta-row"><strong>Worktree:</strong> <code>${escapeHtml(attempt.worktreePath)}</code></div>` : ''}
            ${attemptLogFileHtml}
            ${attempt.workUsed ? `<div class="attempt-meta-row attempt-work-row"><strong>Work:</strong> <div class="attempt-work-content">${formatWorkSpecHtml(attempt.workUsed, escapeHtml)}</div></div>` : ''}
           </div>`
        : '';
      
      // Trigger type badge
      const triggerBadge = attempt.triggerType === 'auto-heal'
        ? '<span class="trigger-badge auto-heal">🔧 Auto-Heal</span>'
        : attempt.triggerType === 'retry'
          ? '<span class="trigger-badge retry">🔄 Retry</span>'
          : '';
      
      // Use in-memory logs; log file is opened on demand via clickable path
      let attemptLogs = attempt.logs || '';
      const phaseTabsHtml = attemptLogs ? this._buildAttemptPhaseTabs({ ...attempt, logs: attemptLogs }) : '';
      
      // Build compact metrics row for this attempt
      const attemptMetricsHtml = attempt.metrics ? this._buildAttemptMetricsHtml(attempt.metrics, attempt.phaseMetrics) : '';
      
      return `
        <div class="attempt-card" data-attempt="${attempt.attemptNumber}">
          <div class="attempt-header" data-expanded="false">
            <div class="attempt-header-left">
              <span class="attempt-badge">#${attempt.attemptNumber}</span>
              ${triggerBadge}
              <span class="step-indicators">${stepIndicators}</span>
              <span class="attempt-time">${timestamp}</span>
              <span class="attempt-duration">(${duration})</span>
            </div>
            <span class="chevron">▶</span>
          </div>
          <div class="attempt-body" style="display: none;">
            <div class="attempt-meta">
              <div class="attempt-meta-row"><strong>Status:</strong> <span class="status-${attempt.status}">${attempt.status}</span></div>
              ${sessionHtml}
            </div>
            ${attemptMetricsHtml}
            ${contextHtml}
            ${errorHtml}
            ${phaseTabsHtml}
          </div>
        </div>
      `;
    }).join('');

    return `
    <div class="section">
      <h3>Attempt History (${attempts.length})</h3>
      ${cards}
    </div>
    `;
  }
  
  /**
   * Build a prominent metrics summary card for aggregated node metrics.
   *
   * @param metrics - The aggregated CopilotUsageMetrics to display.
   * @returns HTML fragment string for the metrics card.
   */
  private _buildMetricsSummaryHtml(metrics: CopilotUsageMetrics, phaseMetrics?: Record<string, CopilotUsageMetrics>): string {
    const statsHtml: string[] = [];
    
    if (metrics.premiumRequests !== undefined) {
      statsHtml.push(`<div class="metrics-stat">🎫 ${formatPremiumRequests(metrics.premiumRequests)}</div>`);
    }
    if (metrics.apiTimeSeconds !== undefined) {
      statsHtml.push(`<div class="metrics-stat">⏱ API: ${formatDurationSeconds(metrics.apiTimeSeconds)}</div>`);
    }
    if (metrics.sessionTimeSeconds !== undefined) {
      statsHtml.push(`<div class="metrics-stat">🕐 Session: ${formatDurationSeconds(metrics.sessionTimeSeconds)}</div>`);
    }
    if (metrics.codeChanges) {
      statsHtml.push(`<div class="metrics-stat">📝 Code: ${formatCodeChanges(metrics.codeChanges)}</div>`);
    }
    
    let modelBreakdownHtml = '';
    if (metrics.modelBreakdown && metrics.modelBreakdown.length > 0) {
      const rows = metrics.modelBreakdown.map(b => {
        const cached = b.cachedTokens ? `, ${formatTokenCount(b.cachedTokens)} cached` : '';
        const reqs = b.premiumRequests !== undefined ? ` (${b.premiumRequests} req)` : '';
        return `<div class="model-row">
          <span class="model-name">${escapeHtml(b.model)}</span>
          <span class="model-tokens">${formatTokenCount(b.inputTokens)} in, ${formatTokenCount(b.outputTokens)} out${cached}${reqs}</span>
        </div>`;
      }).join('');
      
      modelBreakdownHtml = `
        <div class="model-breakdown">
          <div class="model-breakdown-label">Model Breakdown:</div>
          <div class="model-breakdown-list">${rows}</div>
        </div>`;
    }
    
    // Per-phase AI usage breakdown
    let phaseBreakdownHtml = '';
    if (phaseMetrics && Object.keys(phaseMetrics).length > 0) {
      const phaseLabels: Record<string, string> = {
        'prechecks': '🔍 Prechecks',
        'merge-fi': '↙↘ Merge FI',
        'work': '⚙ Work',
        'commit': '📝 Commit Review',
        'postchecks': '✅ Postchecks',
        'merge-ri': '↗↙ Merge RI',
      };
      const phaseOrder = ['merge-fi', 'prechecks', 'work', 'postchecks', 'commit', 'merge-ri'];
      
      const phaseRows = phaseOrder
        .filter(phase => phaseMetrics[phase])
        .map(phase => {
          const pm = phaseMetrics[phase];
          const parts: string[] = [];
          if (pm.premiumRequests !== undefined) parts.push(`${pm.premiumRequests} req`);
          if (pm.apiTimeSeconds !== undefined) parts.push(`${formatDurationSeconds(pm.apiTimeSeconds)} API`);
          if (pm.sessionTimeSeconds !== undefined) parts.push(`${formatDurationSeconds(pm.sessionTimeSeconds)} session`);
          if (pm.codeChanges) parts.push(`${formatCodeChanges(pm.codeChanges)}`);
          
          const modelInfo = pm.modelBreakdown?.map(b => escapeHtml(b.model)).join(', ') || '';
          
          return `<div class="phase-metrics-row">
            <span class="phase-metrics-label">${phaseLabels[phase] || phase}</span>
            <span class="phase-metrics-stats">${parts.join(' · ')}${modelInfo ? ` · ${modelInfo}` : ''}</span>
          </div>`;
        }).join('');
      
      if (phaseRows) {
        phaseBreakdownHtml = `
          <div class="phase-metrics-breakdown">
            <div class="model-breakdown-label">Phase Breakdown:</div>
            ${phaseRows}
          </div>`;
      }
    }
    
    return `
    <div class="section metrics-card">
      <h3>⚡ AI Usage</h3>
      <div class="metrics-stats-grid">${statsHtml.join('')}</div>
      ${modelBreakdownHtml}
      ${phaseBreakdownHtml}
    </div>`;
  }
  
  /**
   * Build a compact metrics row for an individual attempt.
   *
   * @param metrics - The CopilotUsageMetrics for a single attempt.
   * @returns HTML fragment string for a compact metrics display.
   */
  private _buildAttemptMetricsHtml(metrics: CopilotUsageMetrics, phaseMetrics?: Record<string, CopilotUsageMetrics>): string {
    const statsHtml: string[] = [];
    
    if (metrics.premiumRequests !== undefined) {
      statsHtml.push(`<div class="metrics-stat">🎫 ${formatPremiumRequests(metrics.premiumRequests)}</div>`);
    }
    if (metrics.apiTimeSeconds !== undefined) {
      statsHtml.push(`<div class="metrics-stat">⏱ API: ${formatDurationSeconds(metrics.apiTimeSeconds)}</div>`);
    }
    if (metrics.sessionTimeSeconds !== undefined) {
      statsHtml.push(`<div class="metrics-stat">🕐 Session: ${formatDurationSeconds(metrics.sessionTimeSeconds)}</div>`);
    }
    if (metrics.codeChanges) {
      statsHtml.push(`<div class="metrics-stat">📝 Code: ${formatCodeChanges(metrics.codeChanges)}</div>`);
    }
    
    let modelBreakdownHtml = '';
    if (metrics.modelBreakdown && metrics.modelBreakdown.length > 0) {
      const rows = metrics.modelBreakdown.map(b => {
        const cached = b.cachedTokens ? `, ${formatTokenCount(b.cachedTokens)} cached` : '';
        const reqs = b.premiumRequests !== undefined ? ` (${b.premiumRequests} req)` : '';
        return `<div class="model-row">
          <span class="model-name">${escapeHtml(b.model)}</span>
          <span class="model-tokens">${formatTokenCount(b.inputTokens)} in, ${formatTokenCount(b.outputTokens)} out${cached}${reqs}</span>
        </div>`;
      }).join('');
      
      modelBreakdownHtml = `
        <div class="model-breakdown">
          <div class="model-breakdown-label">Model Breakdown:</div>
          <div class="model-breakdown-list">${rows}</div>
        </div>`;
    }
    
    // Per-phase breakdown for this attempt
    let phaseBreakdownHtml = '';
    if (phaseMetrics && Object.keys(phaseMetrics).length > 1) {
      const phaseLabels: Record<string, string> = {
        'prechecks': '🔍 Prechecks',
        'merge-fi': '↙↘ Merge FI',
        'work': '⚙ Work',
        'commit': '📝 Commit Review',
        'postchecks': '✅ Postchecks',
        'merge-ri': '↗↙ Merge RI',
      };
      const phaseOrder = ['merge-fi', 'prechecks', 'work', 'postchecks', 'commit', 'merge-ri'];
      
      const phaseRows = phaseOrder
        .filter(phase => phaseMetrics[phase])
        .map(phase => {
          const pm = phaseMetrics[phase];
          const parts: string[] = [];
          if (pm.premiumRequests !== undefined) parts.push(`${pm.premiumRequests} req`);
          if (pm.apiTimeSeconds !== undefined) parts.push(`${formatDurationSeconds(pm.apiTimeSeconds)} API`);
          if (pm.codeChanges) parts.push(`${formatCodeChanges(pm.codeChanges)}`);
          return `<div class="phase-metrics-row">
            <span class="phase-metrics-label">${phaseLabels[phase] || phase}</span>
            <span class="phase-metrics-stats">${parts.join(' · ')}</span>
          </div>`;
        }).join('');
      
      if (phaseRows) {
        phaseBreakdownHtml = `
          <div class="phase-metrics-breakdown">
            <div class="model-breakdown-label">Phase Breakdown:</div>
            ${phaseRows}
          </div>`;
      }
    }
    
    return `
    <div class="attempt-metrics-card">
      <div class="metrics-stats-grid">${statsHtml.join('')}</div>
      ${modelBreakdownHtml}
      ${phaseBreakdownHtml}
    </div>`;
  }
  
  /**
   * Build phase tabs for a specific historical attempt record.
   *
   * Parses the attempt's combined log output to extract per-phase sections
   * and renders them as selectable tabs with inline log content.
   *
   * @param attempt - The attempt record containing logs and phase data.
   * @returns HTML fragment string for the phase tab UI, or empty string if no logs.
   */
  private _buildAttemptPhaseTabs(attempt: AttemptRecord): string {
    if (!attempt.logs) return '';
    
    // Parse logs to extract phase sections
    const logs = attempt.logs;
    const phases = ['all', 'merge-fi', 'prechecks', 'work', 'commit', 'postchecks', 'merge-ri'] as const;
    
    const phaseLabels: Record<string, string> = {
      'all': '📄 Full Log',
      'merge-fi': '↙↘ Merge FI',
      'prechecks': '✓ Prechecks',
      'work': '⚙ Work',
      'commit': '💾 Commit',
      'postchecks': '✓ Postchecks',
      'merge-ri': '↗↙ Merge RI',
    };
    
    const getPhaseStatus = (phase: string): string => {
      if (phase === 'all') return '';
      const status = (attempt.stepStatuses as any)?.[phase];
      if (status === 'success') return 'success';
      if (status === 'failed') return 'failed';
      if (status === 'skipped') return 'skipped';
      return '';
    };
    
    const tabs = phases.map(phase => {
      const status = getPhaseStatus(phase);
      const statusIcon = status === 'success' ? '✓' : status === 'failed' ? '✗' : status === 'skipped' ? '○' : '';
      return `<button class="attempt-phase-tab ${phase === 'all' ? 'active' : ''} ${status}" 
                      data-phase="${phase}" data-attempt="${attempt.attemptNumber}">
                ${statusIcon} ${phaseLabels[phase]}
              </button>`;
    }).join('');
    
    // Pre-extract logs for each phase
    const extractPhaseLogs = (phase: string): string => {
      if (phase === 'all') return logs;
      
      const phaseMarkers: Record<string, string> = {
        'merge-fi': 'FORWARD INTEGRATION',
        'prechecks': 'PRECHECKS',
        'work': 'WORK',
        'commit': 'COMMIT',
        'postchecks': 'POSTCHECKS',
        'merge-ri': 'REVERSE INTEGRATION',
      };
      
      const marker = phaseMarkers[phase];
      if (!marker) return '';
      
      // Find section between START and END markers
      const startPattern = new RegExp(`=+ ${marker}.*START =+`, 'i');
      const endPattern = new RegExp(`=+ ${marker}.*END =+`, 'i');
      
      const startMatch = logs.match(startPattern);
      const endMatch = logs.match(endPattern);
      
      if (startMatch && endMatch) {
        const startIdx = logs.indexOf(startMatch[0]);
        const endIdx = logs.indexOf(endMatch[0]) + endMatch[0].length;
        return logs.slice(startIdx, endIdx);
      }
      
      // Fallback: filter lines containing section markers
      const lines = logs.split('\n');
      const filtered = lines.filter(line => {
        const upper = line.toUpperCase();
        return upper.includes(`[${phase.toUpperCase()}]`) || upper.includes(marker);
      });
      return filtered.length > 0 ? filtered.join('\n') : `No logs for ${phase} phase.`;
    };
    
    // Store logs data as escaped JSON in hidden element
    const phaseLogsData: Record<string, string> = {};
    phases.forEach(p => phaseLogsData[p] = extractPhaseLogs(p));
    
    return `
      <div class="attempt-phases" data-attempt="${attempt.attemptNumber}">
        <div class="attempt-phase-tabs">${tabs}</div>
        <pre class="attempt-log-viewer" data-attempt="${attempt.attemptNumber}">${escapeHtml(phaseLogsData['all'])}</pre>
        <script type="application/json" class="attempt-logs-data" data-attempt="${attempt.attemptNumber}">
          ${JSON.stringify(phaseLogsData)}
        </script>
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
      padding: 16px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      line-height: 1.5;
    }
    
    /* Header */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .header h2 { margin: 0; font-size: 18px; }
    
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
    .phase-tab.phase-running .phase-icon { color: #3794ff; animation: pulse 1s infinite; }
    @keyframes pulse { 50% { opacity: 0.5; } }
    
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
