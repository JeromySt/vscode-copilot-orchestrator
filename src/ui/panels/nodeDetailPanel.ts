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
  configSectionHtml,
  executionCardHtml,
  attemptMetricsHtml as attemptMetricsTemplateHtml,
  webviewScripts,
  renderNodeDetailStyles,
} from '../templates/nodeDetail';
import { metricsSummaryHtml } from '../templates/nodeDetail/metricsTemplate';

import { NodeDetailController, NodeDetailCommands } from './nodeDetailController';
import type { IPulseEmitter, Disposable as PulseDisposable } from '../../interfaces/IPulseEmitter';
import { webviewScriptTag } from '../webviewUri';



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

/**
 * Render env vars as an HTML details section (collapsed by default).
 */
function formatEnvHtml(env: Record<string, string> | undefined, escapeHtml: (s: string) => string): string {
  if (!env || Object.keys(env).length === 0) { return ''; }
  const rows = Object.entries(env)
    .map(([k, v]) => `<tr><td class="env-key">${escapeHtml(k)}</td><td class="env-val">${escapeHtml(v)}</td></tr>`)
    .join('');
  return `<details class="env-section"><summary>Environment Variables (${Object.keys(env).length})</summary><table class="env-table">${rows}</table></details>`;
}

/**
 * Resolve a work spec from a ref path (e.g., specs/nodeId/attempts/1/work.json).
 * Reads the JSON file, hydrates agent instructionsFile if present.
 * Returns formatted HTML or undefined if file doesn't exist.
 */
function resolveSpecFromRef(ref: string | undefined, storagePath: string, planId: string, escapeHtml: (s: string) => string): string | undefined {
  if (!ref || !storagePath) {return undefined;}
  const path = require('path');
  const fs = require('fs');
  // Try the exact ref path first, then fall back to the "current" spec directory.
  // Prechecks/postchecks are written at plan creation to specs/<nodeId>/current/,
  // but attempt refs point to specs/<nodeId>/attempts/<n>/ which may not have them.
  const specPath = path.join(storagePath, planId, ref);
  const filename = path.basename(ref); // e.g. "prechecks.json"
  const nodeIdMatch = ref.match(/^specs\/([^/]+)\//);
  const currentPath = nodeIdMatch ? path.join(storagePath, planId, 'specs', nodeIdMatch[1], 'current', filename) : undefined;
  
  const tryPaths = [specPath];
  if (currentPath && currentPath !== specPath) { tryPaths.push(currentPath); }
  
  for (const tryPath of tryPaths) {
    try {
      const rawSpec = fs.readFileSync(tryPath, 'utf-8');
      const spec = JSON.parse(rawSpec);
      if (spec.instructionsFile) {
        try {
          const mdPath = path.join(path.dirname(tryPath), spec.instructionsFile);
          spec.instructions = fs.readFileSync(mdPath, 'utf-8');
          delete spec.instructionsFile;
        } catch { /* md not found */ }
      }
      return formatWorkSpecHtml(spec, escapeHtml);
    } catch { /* file not found, try next */ }
  }
  return undefined;
}

function formatWorkSpecHtml(spec: WorkSpec | undefined, escapeHtml: (s: string) => string): string {
  if (!spec) {return '';}
  
  if (typeof spec === 'string') {
    return `<div class="work-code-block">
      <div class="work-code-header"><span class="work-lang-badge">Command</span></div>
      <pre class="work-code"><code>${escapeHtml(spec)}</code></pre>
    </div>`;
  }
  
  const envHtml = formatEnvHtml((spec as any).env, escapeHtml);
  
  switch (spec.type) {
    case 'process': {
      const args = spec.args?.join(' ') || '';
      const cmd = `${spec.executable} ${args}`.trim();
      return `<div class="work-code-block process-block">
        <div class="work-code-header"><span class="work-lang-badge process">Process</span></div>
        <pre class="work-code"><code>${escapeHtml(cmd)}</code></pre>
        ${envHtml}
      </div>`;
    }
    case 'shell': {
      const { name } = getShellDisplayName(spec.shell);
      const formattedCmd = formatShellCommand(spec.command);
      return `<div class="work-code-block shell-block">
        <div class="work-code-header"><span class="work-lang-badge shell">${escapeHtml(name)}</span></div>
        <pre class="work-code"><code>${escapeHtml(formattedCmd)}</code></pre>
        ${envHtml}
      </div>`;
    }
    case 'agent': {
      const instructions = spec.instructions || '';
      const rendered = renderMarkdown(instructions, escapeHtml);
      const modelLabel = spec.model ? escapeHtml(spec.model) : 'unspecified';
      const tierBadge = spec.modelTier ? `<span class="agent-tier tier-${spec.modelTier}">${escapeHtml(spec.modelTier)}</span>` : '';
      return `<div class="work-code-block agent-block">
        <div class="work-code-header"><span class="work-lang-badge agent">Agent</span><span class="agent-model">${modelLabel}</span>${tierBadge}</div>
        <div class="work-instructions">${rendered}</div>
        ${envHtml}
      </div>`;
    }
    default:
      return `<div class="work-code-block">
        <div class="work-code-header"><span class="work-lang-badge">Config</span></div>
        <pre class="work-code"><code>${escapeHtml(JSON.stringify(spec, null, 2))}</code></pre>
        ${envHtml}
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
    
    // Blockquote (>)
    if (trimmed.startsWith('>')) {
      closeLists();
      const quoteContent = trimmed.replace(/^>\s?/, '');
      html += `<blockquote class="md-blockquote">${formatInline(quoteContent, escapeHtml)}</blockquote>`;
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
  private readonly _extensionUri: vscode.Uri;
  private _planId: string;
  private _nodeId: string;
  private _disposables: vscode.Disposable[] = [];
  private _disposed = false;
  private _pulseSubscription?: PulseDisposable;
  private _currentPhase: string | null = null;
  private _lastStatus: string | null = null;
  private _lastWorktreeCleanedUp: boolean | undefined = undefined;
  private _lastAttemptCount = 0;
  private _lastAttemptStatus = '';
  private _configSentOnce = false;
  private _logSentOffset = 0; // byte offset for delta log streaming (legacy — being replaced by subscription manager)
  private _lastDepsStatus = ''; // serialized dependency statuses for change detection
  private _controller: NodeDetailController;
  private _subscriptionManager: import('../webViewSubscriptionManager').WebViewSubscriptionManager;
  
  /**
   * @param panel - The VS Code webview panel instance.
   * @param extensionUri - The extension URI for loading webview resources.
   * @param planId - The Plan ID that contains this node.
   * @param nodeId - The unique identifier of the node to display.
   * @param _planRunner - The {@link PlanRunner} instance for querying state and logs.
   * @param _pulse - Pulse emitter for periodic updates.
   */
  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    planId: string,
    nodeId: string,
    private _planRunner: PlanRunner,
    private _pulse: IPulseEmitter
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._planId = planId;
    this._nodeId = nodeId;
    
    // Initialize subscription manager with log file producer
    const { WebViewSubscriptionManager } = require('../webViewSubscriptionManager');
    const { LogFileProducer } = require('../producers/logFileProducer');
    this._subscriptionManager = new WebViewSubscriptionManager();
    this._subscriptionManager.registerProducer(new LogFileProducer());
    
    // Create controller with VS Code service adapters
    const commands: NodeDetailCommands = {
      executeCommand: (cmd, ...args) => vscode.commands.executeCommand(cmd, ...args),
      openFolder: (p) => vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p), { forceNewWindow: true }),
      refresh: () => this._update(),
      sendLog: (phase) => { this._currentPhase = phase; this._sendLog(phase); },
      sendProcessStats: () => this._sendProcessStats(),
      subscribeLog: (attemptNumber, tag) => this._subscribeLog(attemptNumber, tag),
      unsubscribeLog: (tag) => this._unsubscribeLog(tag),
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
      this._lastAttemptCount = state?.attemptHistory?.length || 0;
      this._update();
    });
    
    // Subscribe to pulse for periodic state checks
    this._pulseSubscription = this._pulse.onPulse(() => {
      // Forward pulse to webview for DurationCounter ticking
      this._panel.webview.postMessage({ type: 'pulse' });

      const plan = this._planRunner.get(this._planId);
      const state = plan?.nodeStates.get(this._nodeId);

      // Resend config on the next pulse if it wasn't delivered yet.
      // This handles the race where _sendConfigUpdate fires before the
      // webview scripts have finished initializing.
      if (!this._configSentOnce) {
        this._sendConfigUpdate();
      }

      // Always send incremental state change so header phase indicator updates
      if (state) {
        const phaseStatus = this._getPhaseStatus(state);
        const currentPhase = getCurrentExecutionPhase(state);
        this._panel.webview.postMessage({
          type: 'stateChange',
          status: state.status,
          phaseStatus,
          currentPhase,
          startedAt: state.startedAt,
          endedAt: state.endedAt,
        });

        // Push dependency status updates when any dependency changes
        if (plan) { this._sendDepsUpdateIfChanged(plan, plan.jobs.get(this._nodeId)); }

        // Push incremental attempt history when new attempts are recorded
        // or when a running placeholder is replaced with a completed record
        if (state.attemptHistory && state.attemptHistory.length > 0) {
          const lastAttempt = state.attemptHistory[state.attemptHistory.length - 1];
          const lastStatus = lastAttempt.status;
          const changed = state.attemptHistory.length > this._lastAttemptCount
            || (lastStatus !== 'running' && this._lastAttemptStatus === 'running');
          if (changed) {
            this._lastAttemptCount = state.attemptHistory.length;
            this._lastAttemptStatus = lastStatus;
            this._sendAttemptUpdate(state);
          }
        }
      }

      if (state?.status === 'running' || state?.status === 'scheduled') {
        // Status changed — send incremental update, NOT full HTML rebuild
        if (this._lastStatus !== state.status) {
          this._lastStatus = state.status;
          // Send state change to webview controls (status badge, duration counter, etc.)
          const phaseStatus = this._getPhaseStatus(state);
          const currentPhase = getCurrentExecutionPhase(state);
          this._panel.webview.postMessage({
            type: 'stateChange',
            status: state.status,
            phaseStatus,
            currentPhase,
            startedAt: state.startedAt,
            endedAt: state.endedAt,
          });
        }
        // Tick subscription manager — delivers log deltas to active subscriptions
        this._subscriptionManager.tick();
        // Push process stats on each pulse while active
        this._sendProcessStats();
      } else if (this._lastStatus === 'running' || this._lastStatus === 'scheduled') {
        // Transitioned from running to terminal — send state change + attempt update
        this._lastStatus = state?.status || null;
        const phaseStatus = this._getPhaseStatus(state!);
        this._panel.webview.postMessage({
          type: 'stateChange',
          status: state?.status,
          phaseStatus,
          startedAt: state?.startedAt,
          endedAt: state?.endedAt,
        });
        // Force-send attempt update after terminal transition with enough delay
        // for the executor to record the completed attempt in history
        if (state) {
          setTimeout(() => { this._sendAttemptUpdate(state); }, 200);
        }
      } else {
        // Terminal state — only send incremental updates for specific changes
        if (state?.worktreeCleanedUp !== this._lastWorktreeCleanedUp) {
          this._lastWorktreeCleanedUp = state?.worktreeCleanedUp;
          // No full rebuild needed — worktree cleanup just changes a label
        }
      }
    });
    
    // Pause/resume subscriptions when panel visibility changes
    const panelId = `${planId}:${nodeId}`;
    this._panel.onDidChangeViewState(e => {
      if (e.webviewPanel.visible) {
        this._subscriptionManager.resumePanel(panelId);
      } else {
        this._subscriptionManager.pausePanel(panelId);
      }
    }, null, this._disposables);
    
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
    pulse?: IPulseEmitter,
    focusAttemptNumber?: number
  ) {
    const key = `${planId}:${nodeId}`;
    
    const existing = NodeDetailPanel.panels.get(key);
    if (existing) {
      existing._panel.reveal();
      existing._update();
      if (focusAttemptNumber) {
        setTimeout(() => existing._focusAttempt(focusAttemptNumber), 200);
      }
      return;
    }
    
    const plan = planRunner.get(planId);
    const node = plan?.jobs.get(nodeId);
    const title = node ? `Job: ${node.name}` : `Job: ${nodeId.slice(0, 8)}`;
    
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
    
    const nodePanel = new NodeDetailPanel(panel, extensionUri, planId, nodeId, planRunner, effectivePulse);
    NodeDetailPanel.panels.set(key, nodePanel);
    if (focusAttemptNumber) {
      setTimeout(() => nodePanel._focusAttempt(focusAttemptNumber), 300);
    }
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
    this._disposed = true;
    const key = `${this._planId}:${this._nodeId}`;
    NodeDetailPanel.panels.delete(key);
    
    // Dispose all log subscriptions for this panel
    this._subscriptionManager.disposePanel(key);
    
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
   * Subscribe to log file updates for a specific attempt.
   * Called when the webview expands an attempt card.
   */
  private _subscribeLog(attemptNumber: number, tag: string): void {
    const logFilePath = this._planRunner.getNodeLogFilePath(this._planId, this._nodeId, attemptNumber);
    if (!logFilePath) { return; }
    const panelId = `${this._planId}:${this._nodeId}`;
    // Avoid duplicate subscriptions
    const existing = this._subscriptionManager.findSubscription(panelId, 'log', logFilePath);
    if (existing) { return; }
    this._subscriptionManager.subscribe(panelId, this._panel.webview, 'log', logFilePath, tag);
  }

  /**
   * Unsubscribe from log file updates for a specific attempt.
   * Called when the webview collapses an attempt card.
   */
  private _unsubscribeLog(tag: string): void {
    // Find and remove the subscription by tag
    const panelId = `${this._planId}:${this._nodeId}`;
    // We need to iterate to find by tag — the manager tracks by ID
    // For simplicity, use panelId + producerType to narrow down
    // In practice there's one log sub per attempt, identified by tag
    for (const sub of (this._subscriptionManager as any).subs?.values() || []) {
      if (sub.panelId === panelId && sub.tag === tag) {
        this._subscriptionManager.unsubscribe(sub.id);
        break;
      }
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
      vscode.window.showInformationMessage(`Job force failed. You can now retry.`);
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
      vscode.window.showInformationMessage(`Job retry initiated${resumeSession ? ' (resuming session)' : ' (fresh session)'}`);
      this._update();
    } else {
      vscode.window.showErrorMessage(`Retry failed: ${result.error}`);
    }
  }
  
  /** Query process stats for this node and send them to the webview. */
  private async _sendProcessStats() {
    if (this._disposed) { return; }
    const stats = await this._planRunner.getProcessStats(this._planId, this._nodeId);
    if (this._disposed) { return; }
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
    if (this._disposed) { return; }
    const plan = this._planRunner.get(this._planId);
    const node = plan?.jobs.get(this._nodeId);
    const state = plan?.nodeStates.get(this._nodeId);
    
    // Always send a response - never leave webview hanging
    if (!plan || !node) {
      this._panel.webview.postMessage({
        type: 'logContent',
        phase,
        content: 'Plan or job not found.',
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

  /**
   * Send only new log lines since last offset (delta streaming).
   * Avoids sending the full log on every pulse — much faster for large logs.
   */
  private _sendLogDelta(): void {
    if (this._disposed) { return; }
    const plan = this._planRunner.get(this._planId);
    const state = plan?.nodeStates.get(this._nodeId);
    if (!plan || !state) { return; }

    const attemptNumber = state.attempts || 1;
    const logFilePath = this._planRunner.getNodeLogFilePath(this._planId, this._nodeId, attemptNumber);
    if (!logFilePath) { return; }

    try {
      const fs = require('fs');
      // Open file first, then fstat to avoid TOCTOU race
      const fd = fs.openSync(logFilePath, 'r');
      try {
        const stat = fs.fstatSync(fd);
        if (stat.size <= this._logSentOffset) { fs.closeSync(fd); return; }

        const newBytes = Buffer.alloc(stat.size - this._logSentOffset);
        fs.readSync(fd, newBytes, 0, newBytes.length, this._logSentOffset);
        const newContent = newBytes.toString('utf-8');
        this._logSentOffset = stat.size;

        this._panel.webview.postMessage({
          type: 'logContent',
          phase: 'all',
          content: newContent,
          append: true,
        });
      } finally {
        fs.closeSync(fd);
      }
    } catch { /* file may not exist yet */ }
  }

  /**
   * Send the full log file content (initial load on panel open).
   * Sets the offset so subsequent pulses only send deltas.
   */
  private _sendFullLog(): void {
    if (this._disposed) { return; }
    const plan = this._planRunner.get(this._planId);
    const state = plan?.nodeStates.get(this._nodeId);
    if (!plan || !state) { return; }

    const attemptNumber = state.attempts || 1;
    const logFilePath = this._planRunner.getNodeLogFilePath(this._planId, this._nodeId, attemptNumber);
    if (!logFilePath) { return; }

    try {
      const fs = require('fs');
      const content = fs.readFileSync(logFilePath, 'utf-8');
      this._logSentOffset = Buffer.byteLength(content, 'utf-8');

      this._panel.webview.postMessage({
        type: 'logContent',
        phase: 'all',
        content,
        append: false, // full replace — initial load
      });
    } catch { /* file may not exist yet */ }
  }

  /** Send config update to webview for live config display updates. */
  private async _sendConfigUpdate() {
    const plan = this._planRunner.get(this._planId);
    const node = plan?.jobs.get(this._nodeId);
    const state = plan?.nodeStates.get(this._nodeId);
    
    if (!node || node.type !== 'job') {return;}
    
    // Hydrate specs from disk if not inline (finalized plans store specs on disk)
    const work = node.work || await plan?.definition?.getWorkSpec(this._nodeId);
    const prechecks = node.prechecks || await plan?.definition?.getPrechecksSpec(this._nodeId);
    const postchecks = node.postchecks || await plan?.definition?.getPostchecksSpec(this._nodeId);
    
    // Send raw spec objects to the webview — ConfigDisplay handles rendering.
    // For agent specs, also send pre-rendered markdown HTML since the webview
    // doesn't have a markdown renderer.
    const renderAgentHtml = (spec: any) => {
      if (!spec) return undefined;
      const normalized = normalizeWorkSpec(spec);
      if (normalized && typeof normalized === 'object' && normalized.type === 'agent' && normalized.instructions) {
        return renderMarkdown(normalized.instructions, escapeHtml);
      }
      return undefined;
    };
    this._panel.webview.postMessage({
      type: 'configUpdate',
      data: {
        work: work || undefined,
        workInstructionsHtml: renderAgentHtml(work),
        prechecks: prechecks || undefined,
        prechecksInstructionsHtml: renderAgentHtml(prechecks),
        postchecks: postchecks || undefined,
        postchecksInstructionsHtml: renderAgentHtml(postchecks),
        task: node.task,
        currentPhase: getCurrentExecutionPhase(state),
        expectsNoChanges: node.expectsNoChanges,
      }
    });
    this._configSentOnce = true;
  }
  
  /**
   * Push attempt history updates to the webview for dynamic rendering.
   * 
   * Builds full attempt card data (logs from disk, work spec resolution, metrics)
   * so the webview renders complete attempt cards without requiring panel close/reopen.
   *
   * @param state - The current node execution state.
   */
  private async _sendAttemptUpdate(state: NodeExecutionState): Promise<void> {
    const plan = this._planRunner.get(this._planId);
    if (!plan) { return; }
    const node = plan.jobs.get(this._nodeId);
    
    // For jobs with no attemptHistory (pre-execution or jobs where the executor
    // didn't record the attempt), synthesize a card from the nodeState.
    if (!state.attemptHistory || state.attemptHistory.length === 0) {
      // Resolve work spec — inline first, then from disk for finalized plans
      let workSpec = node?.work;
      if (!workSpec && plan.definition) {
        try { workSpec = await plan.definition.getWorkSpec(this._nodeId); } catch { /* */ }
      }
      let workSpecHtml: string | undefined;
      if (workSpec) {
        workSpecHtml = formatWorkSpecHtml(workSpec, escapeHtml);
      }
      // Read logs from file if available
      const logFilePath = this._planRunner.getNodeLogFilePath(this._planId, this._nodeId, state.attempts || 1);
      let logs = '';
      if (logFilePath && state.status !== 'running') {
        try { logs = require('fs').readFileSync(logFilePath, 'utf-8'); } catch { /* */ }
      }
      // Resolve prechecks/postchecks specs from node definition or disk
      const storagePath0 = this._planRunner.getStoragePath?.() || '';
      let prechecksSpec = node?.prechecks;
      if (!prechecksSpec || (prechecksSpec as any).instructionsRef) {
        // Try plan.definition first (reads from disk with hydration)
        if (plan.definition) {
          try { prechecksSpec = await plan.definition.getPrechecksSpec(this._nodeId); } catch (e: any) { console.error('getPrechecksSpec error:', e?.message); }
        }
        // Fallback: try resolveSpecFromRef with current/ path
        if (!prechecksSpec && storagePath0) {
          const ref = `specs/${this._nodeId}/current/prechecks.json`;
          const html = resolveSpecFromRef(ref, storagePath0, plan.id, escapeHtml);
          if (html) { /* prechecksSpec stays undefined but we have HTML */ }
        }
      }
      let prechecksHtml: string | undefined;
      if (prechecksSpec) {
        prechecksHtml = formatWorkSpecHtml(prechecksSpec, escapeHtml);
      } else if (storagePath0) {
        // Direct ref fallback
        prechecksHtml = resolveSpecFromRef(`specs/${this._nodeId}/current/prechecks.json`, storagePath0, plan.id, escapeHtml);
      }
      
      let postchecksSpec = node?.postchecks;
      if (!postchecksSpec || (postchecksSpec as any).instructionsRef) {
        if (plan.definition) {
          try { postchecksSpec = await plan.definition.getPostchecksSpec(this._nodeId); } catch (e: any) { console.error('getPostchecksSpec error:', e?.message); }
        }
      }
      let postchecksHtml: string | undefined;
      if (postchecksSpec) {
        postchecksHtml = formatWorkSpecHtml(postchecksSpec, escapeHtml);
      } else if (storagePath0) {
        postchecksHtml = resolveSpecFromRef(`specs/${this._nodeId}/current/postchecks.json`, storagePath0, plan.id, escapeHtml);
      }
      const nodeMetrics = getNodeMetrics(state);
      const planEnvHtml = formatEnvHtml(plan.env, escapeHtml);
      this._panel.webview.postMessage({
        type: 'attemptUpdate',
        planEnvHtml: planEnvHtml || undefined,
        attempts: [{
          attemptNumber: state.attempts || 1,
          status: state.status || 'pending',
          triggerType: state.attempts && state.attempts > 1 ? 'retry' : (state.status === 'pending' || state.status === 'ready' ? 'planned' : 'initial'),
          startedAt: state.startedAt,
          endedAt: state.endedAt,
          error: state.error,
          failedPhase: state.lastAttempt?.phase,
          exitCode: state.lastAttempt?.exitCode,
          copilotSessionId: state.copilotSessionId,
          stepStatuses: state.stepStatuses,
          worktreePath: state.worktreePath,
          baseCommit: state.baseCommit,
          logFilePath,
          workUsedHtml: workSpecHtml,
          prechecksUsedHtml: prechecksHtml,
          postchecksUsedHtml: postchecksHtml,
          logs,
          metricsHtml: nodeMetrics ? attemptMetricsTemplateHtml(nodeMetrics, state.phaseMetrics) : '',
        }],
      });
      return;
    }
    
    const attempts = [];
    for (const attempt of state.attemptHistory) {
      // Resolve log file path (same logic as full rebuild)
      let resolvedLogPath = attempt.logFilePath;
      if (attempt.logsRef && !attempt.logFilePath?.includes(':')) {
        const storagePath = this._planRunner.getStoragePath?.() || '';
        if (storagePath) {
          resolvedLogPath = require('path').join(storagePath, plan.id, attempt.logsRef);
        }
      }
      if (resolvedLogPath && !resolvedLogPath.includes(':') && !resolvedLogPath.startsWith('/')) {
        const storagePath = this._planRunner.getStoragePath?.() || '';
        if (storagePath) {
          resolvedLogPath = require('path').join(storagePath, plan.id, resolvedLogPath);
        }
      }

      // Read logs from attempt-specific file (skip for running attempts — live streaming handles those)
      let attemptLogs = attempt.logs || '';
      const currentLogFilePath = this._planRunner.getNodeLogFilePath(this._planId, this._nodeId, attempt.attemptNumber || state.attempts || 1);
      const effectiveLogPath = resolvedLogPath || currentLogFilePath;
      if (!attemptLogs && effectiveLogPath && attempt.status !== 'running') {
        try {
          attemptLogs = require('fs').readFileSync(effectiveLogPath, 'utf-8');
        } catch { /* file may not exist yet */ }
      }

      // Resolve work/prechecks/postchecks specs
      const storagePath = this._planRunner.getStoragePath?.() || '';
      let workUsedHtml: string | undefined;
      if (attempt.workUsed) {
        workUsedHtml = formatWorkSpecHtml(attempt.workUsed, escapeHtml);
      } else {
        workUsedHtml = resolveSpecFromRef(attempt.workRef, storagePath, plan.id, escapeHtml);
      }
      // For running attempts with no resolved work spec, fall back to node's work spec or disk
      if (!workUsedHtml && (attempt.status === 'running' || !attempt.workUsed)) {
        let fallbackWork = node?.work;
        if (!fallbackWork && plan.definition) {
          try { fallbackWork = await plan.definition.getWorkSpec(this._nodeId); } catch { /* */ }
        }
        if (fallbackWork) {
          workUsedHtml = formatWorkSpecHtml(fallbackWork, escapeHtml);
        }
      }
      // Resolve prechecks — try ref first, then node inline, then disk via definition
      let prechecksUsedHtml = resolveSpecFromRef(attempt.prechecksRef, storagePath, plan.id, escapeHtml);
      if (!prechecksUsedHtml && (attempt.status === 'running' || !attempt.prechecksRef)) {
        let fallbackPrechecks = node?.prechecks;
        if ((!fallbackPrechecks || (fallbackPrechecks as any).instructionsRef) && plan.definition) {
          try { fallbackPrechecks = await plan.definition.getPrechecksSpec(this._nodeId); } catch { /* */ }
        }
        if (fallbackPrechecks) { prechecksUsedHtml = formatWorkSpecHtml(fallbackPrechecks, escapeHtml); }
      }
      // Resolve postchecks — try ref first, then node inline, then disk via definition
      let postchecksUsedHtml = resolveSpecFromRef(attempt.postchecksRef, storagePath, plan.id, escapeHtml);
      if (!postchecksUsedHtml && (attempt.status === 'running' || !attempt.postchecksRef)) {
        let fallbackPostchecks = node?.postchecks;
        if ((!fallbackPostchecks || (fallbackPostchecks as any).instructionsRef) && plan.definition) {
          try { fallbackPostchecks = await plan.definition.getPostchecksSpec(this._nodeId); } catch { /* */ }
        }
        if (fallbackPostchecks) { postchecksUsedHtml = formatWorkSpecHtml(fallbackPostchecks, escapeHtml); }
      }

      attempts.push({
        attemptNumber: attempt.attemptNumber,
        status: attempt.status,
        triggerType: attempt.triggerType,
        startedAt: attempt.startedAt,
        endedAt: attempt.endedAt,
        error: attempt.error,
        failedPhase: attempt.failedPhase,
        exitCode: attempt.exitCode,
        copilotSessionId: attempt.copilotSessionId || (attempt.status === 'running' ? state.copilotSessionId : undefined),
        stepStatuses: attempt.stepStatuses || (attempt.status === 'running' ? state.stepStatuses : undefined),
        // Running attempts may not have context yet — fall back to current nodeState
        worktreePath: attempt.worktreePath || (attempt.status === 'running' ? state.worktreePath : undefined),
        baseCommit: attempt.baseCommit || (attempt.status === 'running' ? state.baseCommit : undefined),
        logFilePath: resolvedLogPath || (attempt.status === 'running' ? currentLogFilePath : undefined),
        workUsedHtml,
        prechecksUsedHtml,
        postchecksUsedHtml,
        // Running attempts get live streaming via LOG_UPDATE, completed get static logs
        logs: attemptLogs,
        metricsHtml: attempt.metrics 
          ? attemptMetricsTemplateHtml(attempt.metrics, attempt.phaseMetrics) 
          : (attempt.status === 'running' && state.metrics 
            ? attemptMetricsTemplateHtml(state.metrics, state.phaseMetrics) 
            : ''),
      });
    }

    const planEnvHtml = formatEnvHtml(plan.env, escapeHtml);
    this._panel.webview.postMessage({
      type: 'attemptUpdate',
      planEnvHtml: planEnvHtml || undefined,
      attempts,
    });
  }

  /**
   * Push AI usage metrics to the webview.
   *
   * @param state - The current node execution state.
   */
  /**
   * Send a message to the webview to expand and scroll to a specific attempt.
   */
  private _focusAttempt(attemptNumber: number): void {
    this._panel.webview.postMessage({
      type: 'focusAttempt',
      attemptNumber,
    });
  }

  private _sendAiUsageUpdate(state: NodeExecutionState): void {
    if (this._disposed) { return; }
    const metrics = getNodeMetrics(state);
    if (!metrics) {return;}
    this._panel.webview.postMessage({
      type: 'aiUsageUpdate',
      premiumRequests: metrics.premiumRequests,
      apiTimeSeconds: metrics.apiTimeSeconds,
      sessionTimeSeconds: metrics.sessionTimeSeconds,
      codeChanges: metrics.codeChanges,
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

  /** Push dependency status updates only when something changed. */
  private _sendDepsUpdateIfChanged(plan: PlanInstance, node: JobNode | undefined): void {
    if (this._disposed || !node) { return; }
    const deps = node.dependencies.map(depId => {
      const depNode = plan.jobs.get(depId);
      const depState = plan.nodeStates.get(depId);
      return { name: depNode?.name || depId, status: depState?.status || 'pending' };
    });
    const key = deps.map(d => d.name + ':' + d.status).join(',');
    if (key === this._lastDepsStatus) { return; }
    this._lastDepsStatus = key;
    this._panel.webview.postMessage({ type: 'depsUpdate', dependencies: deps });
  }
  
  /** Re-render the panel HTML with current node state. */
  private async _update() {
    const plan = this._planRunner.get(this._planId);
    if (!plan) {
      this._panel.webview.html = this._getErrorHtml('Plan not found');
      return;
    }
    
    const node = plan.jobs.get(this._nodeId);
    const state = plan.nodeStates.get(this._nodeId);
    
    if (!node || !state) {
      this._panel.webview.html = this._getErrorHtml('Job not found');
      return;
    }
    
    // Resolve specs from disk for finalized plans (node.work etc. may be undefined)
    const resolvedWork = node.work || await plan.definition?.getWorkSpec(this._nodeId);
    const resolvedPrechecks = node.prechecks || await plan.definition?.getPrechecksSpec(this._nodeId);
    const resolvedPostchecks = node.postchecks || await plan.definition?.getPostchecksSpec(this._nodeId);
    
    this._panel.webview.html = this._getHtml(plan, node, state, resolvedWork, resolvedPrechecks, resolvedPostchecks);

    // Set attempt tracking to match current state so the next pulse doesn't
    // trigger an unnecessary rebuild (which would wipe the log container)
    this._lastAttemptCount = state.attemptHistory?.length || 0;
    this._lastAttemptStatus = state.attemptHistory?.length
      ? state.attemptHistory[state.attemptHistory.length - 1].status
      : '';
    this._configSentOnce = false; // Reset — webview was rebuilt, config needs resending
    this._logSentOffset = 0; // Reset delta offset — webview has no log content yet

    // Send initial full log content AFTER the attempt card has been built.
    // _sendAttemptUpdate fires at 75ms, so we send full log at 250ms to ensure
    // the <pre> element exists before we populate it.
    setTimeout(() => { this._sendFullLog(); }, 250);
    
    // After HTML rebuild, send messages with delays so the webview scripts
    // have time to initialize the EventBus and subscribe controls.
    // Config update must be deferred like stateChange — it's async and the
    // webview needs its controls wired before it can process the message.
    setTimeout(() => { this._sendConfigUpdate(); }, 50);

    // Send initial attempt history to the CSR AttemptCard control
    setTimeout(() => { this._sendAttemptUpdate(state).catch(err => console.error('sendAttemptUpdate failed:', err)); }, 75);

    // After HTML rebuild, send stateChange to re-initialize DurationCounterControl
    const phaseStatus = this._getPhaseStatus(state);
    const currentPhase = getCurrentExecutionPhase(state);
    // Give webview time to initialize before sending state
    setTimeout(() => {
      this._panel.webview.postMessage({
        type: 'stateChange',
        status: state.status,
        phaseStatus,
        currentPhase,
        startedAt: state.startedAt,
        endedAt: state.endedAt,
      });
    }, 100);

    // Send an immediate pulse so DurationCounterControl gets a tick right away
    setTimeout(() => {
      this._panel.webview.postMessage({ type: 'pulse' });
    }, 150);
  }
  
  /**
   * Generate a loading spinner page HTML.
   *
   * @returns Full HTML document string with a loading animation.
   */
  private _getLoadingHtml(): string {
    return loadingPageHtml('Loading job details...');
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
    state: NodeExecutionState,
    resolvedWork?: any,
    resolvedPrechecks?: any,
    resolvedPostchecks?: any,
  ): string {
    
    const duration = state.startedAt 
      ? formatDuration(Math.round(((state.endedAt || Date.now()) - state.startedAt) / 1000))
      : null;
    
    // Build phase status indicators
    const phaseStatus = this._getPhaseStatus(state);
    
    // Determine initial phase to show
    const initialPhase = this._getInitialPhase(phaseStatus, state.status);
    
    // Build aggregate AI usage metrics (sum of all attempts)
    const nodeMetrics = getNodeMetrics(state);
    const nodeMetricsHtml = nodeMetrics ? metricsSummaryHtml(nodeMetrics, state.phaseMetrics) : '';

    // Build work summary HTML
    // For leaf nodes, pass aggregated work summary to show total merged work
    const isLeaf = plan.leaves.includes(this._nodeId);
    const workSummaryHtml = state.workSummary 
      ? this._buildWorkSummaryHtml(state.workSummary, state.aggregatedWorkSummary, isLeaf)
      : '';
    
    // Get log file path for this node (use current attempt number)
    const logFilePath = this._planRunner.getNodeLogFilePath(this._planId, this._nodeId, state.attempts || 1);

    // Attempt history is rendered entirely by the CSR AttemptCard control.
    // Initial data is pushed via _sendAttemptUpdate() after HTML rebuild.

    // Build dependencies data
    const dependencies = node.dependencies.map(depId => {
      const depNode = plan.jobs.get(depId);
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' ${this._panel.webview.cspSource};">
  <style>
    ${renderNodeDetailStyles()}
  </style>
</head>
<body>
  <div class="sticky-header">
  ${breadcrumbHtml(plan.id, plan.spec.name, node.name)}
  
  ${headerRowHtml(node.name, state.status, state.startedAt, state.endedAt)}
  ${forceFailButtonHtml(actionData)}
  </div>
  
  ${retryButtonsHtml(actionData)}
  
  <div id="aiUsageStatsContainer" style="${nodeMetricsHtml ? '' : 'display:none;'}">
    ${nodeMetricsHtml}
  </div>
  
  <div class="attempt-history-container"></div>
  
  ${workSummaryHtml}
  <div id="workSummaryContainer" style="display:none;"></div>
  
  ${dependenciesSectionHtml(dependencies)}
  
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
  
  ${webviewScriptTag(this._panel.webview, this._extensionUri, 'nodeDetail')}
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
    // Always produce all phases: merge-fi, prechecks, work, commit, postchecks, merge-ri.
    // stepStatuses (from executor) covers prechecks/work/commit/postchecks/merge-ri.
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
      result['merge-fi'] = ss['merge-fi'] || 'pending';
      result.prechecks = ss.prechecks || 'pending';
      result.work = ss.work || 'pending';
      result.commit = ss.commit || 'pending';
      result.postchecks = ss.postchecks || 'pending';
      result['merge-ri'] = ss['merge-ri'] || 'pending';
    }
    
    const status = state.status;
    const error = state.error || '';
    const failedPhase = state.lastAttempt?.phase;
    
    if (status === 'succeeded') {
      // When stepStatuses exist, they already have the correct values (including 'skipped').
      // Only set merge-fi/merge-ri to 'success' as fallback when no stepStatuses.
      if (!ss) {
        result['merge-fi'] = 'success';
        result.prechecks = 'success';
        result.work = 'success';
        result.commit = 'success';
        result.postchecks = 'success';
        result['merge-ri'] = 'success';
      }
    } else if (status === 'failed') {
      // When stepStatuses exist, merge-fi/merge-ri are already populated.
      // Only override specific phases for the failure indicator and fallback heuristics.
      // Check for merge-ri failure (via lastAttempt.phase or error message)
      if (failedPhase === 'merge-ri' || error.includes('Reverse integration merge')) {
        if (!ss) {
          result['merge-fi'] = 'success';
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
      }
    } else if (status === 'running') {
      if (!ss) {
        result['merge-fi'] = 'success';
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
  
}
