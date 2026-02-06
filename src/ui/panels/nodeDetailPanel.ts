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
import { PlanRunner, PlanInstance, JobNode, SubPlanNode, NodeExecutionState, JobWorkSummary, WorkSpec, AttemptRecord } from '../../plan';

/**
 * Format a WorkSpec for display
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
 * Node Detail Panel - shows job/node execution details with logs
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
    setImmediate(() => this._update());
    
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
   * Close all node panels associated with a Plan (used when Plan is deleted)
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
        this._retryNode(message.planId, message.nodeId, message.resumeSession);
        break;
    }
  }
  
  private _retryNode(planId: string, nodeId: string, resumeSession: boolean) {
    // If resumeSession is false, provide an agent spec that clears the session
    const newWork = resumeSession ? undefined : { type: 'agent' as const, instructions: '', resumeSession: false };
    
    const result = this._planRunner.retryNode(planId, nodeId, {
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
  
  private async _sendProcessStats() {
    const stats = await this._planRunner.getProcessStats(this._planId, this._nodeId);
    this._panel.webview.postMessage({
      type: 'processStats',
      ...stats
    });
  }
  
  private async _sendLog(phase: string) {
    const plan = this._planRunner.get(this._planId);
    const node = plan?.nodes.get(this._nodeId);
    if (!node) return;
    
    // Get logs from executor (works for both jobs and sub-plan nodes)
    const logs = this._planRunner.getNodeLogs(this._planId, this._nodeId, phase as any);
    
    this._panel.webview.postMessage({
      type: 'logContent',
      phase,
      content: logs || 'No logs available for this phase.'
    });
  }
  
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
  
  private _getLoadingHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <style>
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      padding: 20px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .loading-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 60px 20px;
    }
    .loading-spinner {
      width: 40px;
      height: 40px;
      border: 3px solid var(--vscode-panel-border);
      border-top-color: var(--vscode-progressBar-background);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-text { margin-top: 16px; font-size: 14px; opacity: 0.8; }
  </style>
</head>
<body>
  <div class="loading-container">
    <div class="loading-spinner"></div>
    <div class="loading-text">Loading node details...</div>
  </div>
</body>
</html>`;
  }
  
  private _getErrorHtml(message: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
</head>
<body style="padding: 20px; color: var(--vscode-errorForeground);">
  <h2>Error</h2>
  <p>${message}</p>
</body>
</html>`;
  }
  
  private _getHtml(
    plan: PlanInstance,
    node: JobNode | SubPlanNode,
    state: NodeExecutionState
  ): string {
    const isJob = node.type === 'job';
    const jobNode = isJob ? node as JobNode : null;
    const subPlanNode = !isJob ? node as SubPlanNode : null;
    
    const duration = state.startedAt 
      ? this._formatDuration(Math.round(((state.endedAt || Date.now()) - state.startedAt) / 1000))
      : null;
    
    // Build phase status indicators
    const phaseStatus = this._getPhaseStatus(state);
    
    // Build work summary HTML
    const workSummaryHtml = state.workSummary 
      ? this._buildWorkSummaryHtml(state.workSummary)
      : '';
    
    // Build child Plan summary HTML if this is a subPlan node
    const childPlanSummaryHtml = subPlanNode?.childPlanId
      ? this._buildchildPlanSummaryHtml(subPlanNode.childPlanId)
      : '';
    
    // Build attempt history HTML (only if multiple attempts)
    const attemptHistoryHtml = (state.attemptHistory && state.attemptHistory.length > 0)
      ? this._buildAttemptHistoryHtml(state)
      : '';

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
    <a onclick="openPlan('${plan.id}')">${this._escapeHtml(plan.spec.name)}</a> / ${this._escapeHtml(node.name)}
  </div>
  
  <div class="header">
    <h2>${this._escapeHtml(node.name)}</h2>
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
        <div class="meta-value">${duration}</div>
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
      <strong>Error:</strong> ${this._escapeHtml(state.error)}
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
  </div>
  
  ${(state.status === 'running' || state.status === 'scheduled') && isJob ? `
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
  
  ${isJob && jobNode ? `
  <!-- Job Configuration -->
  <div class="section">
    <h3>Job Configuration</h3>
    <div class="config-item">
      <div class="config-label">Task</div>
      <div class="config-value">${this._escapeHtml(jobNode.task)}</div>
    </div>
    ${jobNode.work ? `
    <div class="config-item">
      <div class="config-label">Work</div>
      <div class="config-value mono">${this._escapeHtml(formatWorkSpec(jobNode.work))}</div>
    </div>
    ` : ''}
    ${jobNode.instructions ? `
    <div class="config-item">
      <div class="config-label">Instructions</div>
      <div class="config-value">${this._escapeHtml(jobNode.instructions)}</div>
    </div>
    ` : ''}
  </div>
  
  <!-- Phase Progress -->
  <div class="section">
    <h3>Execution Phases</h3>
    <div class="phase-tabs">
      ${this._buildPhaseTabs(phaseStatus, state.status === 'running')}
    </div>
    <div class="log-viewer" id="logViewer">
      <div class="log-placeholder">Select a phase tab to view logs</div>
    </div>
  </div>
  
  ${workSummaryHtml}
  ` : ''}
  
  ${subPlanNode ? `
  <!-- sub-plan Info -->
  <div class="section">
    <h3>sub-plan Configuration</h3>
    <div class="config-item">
      <div class="config-label">Jobs</div>
      <div class="config-value">${subPlanNode.childSpec.jobs.length} jobs defined</div>
    </div>
    ${subPlanNode.childPlanId ? `
    <div class="config-item">
      <div class="config-label">child Plan</div>
      <div class="config-value">
        <a onclick="openPlan('${subPlanNode.childPlanId}')" class="link">${subPlanNode.childPlanId.slice(0, 8)}...</a>
        <button class="action-btn secondary" style="margin-left: 8px; padding: 2px 8px; font-size: 11px;" onclick="openPlan('${subPlanNode.childPlanId}')">Open Plan</button>
      </div>
    </div>
    ` : ''}
  </div>
  ${childPlanSummaryHtml}
  ` : ''}
  
  <!-- Dependencies -->
  <div class="section">
    <h3>Dependencies</h3>
    ${node.dependencies.length > 0 ? `
    <div class="deps-list">
      ${node.dependencies.map(depId => {
        const depNode = plan.nodes.get(depId);
        const depState = plan.nodeStates.get(depId);
        return `<span class="dep-badge ${depState?.status || 'pending'}">${this._escapeHtml(depNode?.name || depId)}</span>`;
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
      <div class="config-value mono" style="${state.worktreeCleanedUp ? 'text-decoration: line-through; opacity: 0.6;' : ''}">${this._escapeHtml(state.worktreePath)}</div>
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
    let currentPhase = ${this._currentPhase ? `'${this._currentPhase}'` : 'null'};
    
    // Restore phase selection if we had one
    if (currentPhase) {
      setTimeout(() => selectPhase(currentPhase), 50);
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
    
    // Session ID copy handler
    document.querySelectorAll('.session-id').forEach(el => {
      el.addEventListener('click', () => {
        const sessionId = el.getAttribute('data-session');
        vscode.postMessage({ type: 'copyToClipboard', text: sessionId });
      });
    });
    
    // Retry button handlers
    document.querySelectorAll('.retry-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        const planId = btn.getAttribute('data-plan-id');
        const nodeId = btn.getAttribute('data-node-id');
        
        if (action === 'retry-node') {
          vscode.postMessage({ type: 'retryNode', planId, nodeId, resumeSession: true });
        } else if (action === 'retry-node-fresh') {
          vscode.postMessage({ type: 'retryNode', planId, nodeId, resumeSession: false });
        }
      });
    });
    
    // Attempt card toggle handlers
    document.querySelectorAll('.attempt-header').forEach(header => {
      header.addEventListener('click', () => {
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
    });
    
    // Attempt phase tab click handlers
    document.querySelectorAll('.attempt-phase-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
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
    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'logContent' && msg.phase === currentPhase) {
        const viewer = document.getElementById('logViewer');
        viewer.innerHTML = '<pre class="log-content" tabindex="0">' + escapeHtml(msg.content) + '</pre>';
        viewer.scrollTop = viewer.scrollHeight;
        
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
      
      if (!stats.pid || !stats.running) {
        if (lastKnownTree.length === 0) {
          treeEl.innerHTML = '<div class="process-loading">No active process</div>';
          titleEl.textContent = 'Processes';
        }
        return;
      }
      
      const tree = stats.tree || [];
      lastKnownTree = tree;
      
      if (tree.length === 0) {
        treeEl.innerHTML = '<div class="process-loading">Process running (PID ' + stats.pid + ')</div>';
        titleEl.innerHTML = 'Processes <span style="opacity: 0.7; font-weight: normal;">PID ' + stats.pid + '</span>';
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
      titleEl.innerHTML = 'Processes <span style="opacity: 0.7; font-weight: normal;">(' + totals.count + ' • ' + totals.cpu.toFixed(0) + '% CPU • ' + memMB + ' MB)</span>';
      
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
    
    // Poll for process stats if running
    const processTreeSection = document.getElementById('processTreeSection');
    if (processTreeSection) {
      vscode.postMessage({ type: 'getProcessStats' });
      setInterval(() => {
        vscode.postMessage({ type: 'getProcessStats' });
      }, 2000);
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
  
  private _getPhaseStatus(state: NodeExecutionState): Record<string, string> {
    // Use tracked stepStatuses if available (from executor)
    if (state.stepStatuses) {
      return {
        prechecks: state.stepStatuses.prechecks || 'pending',
        work: state.stepStatuses.work || 'pending',
        commit: state.stepStatuses.commit || 'pending',
        postchecks: state.stepStatuses.postchecks || 'pending',
      };
    }
    
    // Fallback: derive phase status from execution state and error message
    const status = state.status;
    const error = state.error || '';
    
    // Default all to pending
    const result: Record<string, string> = {
      'merge-fi': 'pending',
      prechecks: 'pending',
      work: 'pending',
      commit: 'pending',
      postchecks: 'pending',
      'merge-ri': 'pending',
    };
    
    if (status === 'succeeded') {
      // All phases succeeded
      result['merge-fi'] = 'success';
      result.prechecks = 'success';
      result.work = 'success';
      result.commit = 'success';
      result.postchecks = 'success';
      result['merge-ri'] = 'success';
    } else if (status === 'failed') {
      // Determine which phase failed based on error message
      if (error.includes('merge sources') || error.includes('Forward integration')) {
        result['merge-fi'] = 'failed';
      } else if (error.includes('Prechecks failed')) {
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
    } else if (status === 'running') {
      // Running - can't tell exactly which phase, default to work
      result['merge-fi'] = 'success';
      result.prechecks = 'success';
      result.work = 'running';
    }
    
    return result;
  }
  
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
  
  private _getPhaseIcon(status: string): string {
    switch (status) {
      case 'success': return '✓';
      case 'failed': return '✗';
      case 'running': return '⟳';
      case 'skipped': return '⊘';
      default: return '○';
    }
  }
  
  private _getMergeIcon(status: string, arrow: string): string {
    switch (status) {
      case 'success': return `✓${arrow}`;
      case 'failed': return `✗${arrow}`;
      case 'running': return `⟳${arrow}`;
      case 'skipped': return `○${arrow}`;
      default: return `○${arrow}`;
    }
  }
  
  private _buildWorkSummaryHtml(ws: JobWorkSummary): string {
    if (!ws || (ws.commits === 0 && ws.filesAdded === 0 && ws.filesModified === 0 && ws.filesDeleted === 0)) {
      return '';
    }
    
    // Build commit details HTML if available
    let commitsHtml = '';
    if (ws.commitDetails && ws.commitDetails.length > 0) {
      commitsHtml = `<div class="commits-list">`;
      for (const commit of ws.commitDetails) {
        let filesHtml = '';
        if (commit.filesAdded?.length) {
          filesHtml += commit.filesAdded.map(f => `<div class="file-item file-added">+${this._escapeHtml(f)}</div>`).join('');
        }
        if (commit.filesModified?.length) {
          filesHtml += commit.filesModified.map(f => `<div class="file-item file-modified">~${this._escapeHtml(f)}</div>`).join('');
        }
        if (commit.filesDeleted?.length) {
          filesHtml += commit.filesDeleted.map(f => `<div class="file-item file-deleted">-${this._escapeHtml(f)}</div>`).join('');
        }
        
        commitsHtml += `
          <div class="commit-item">
            <code class="commit-hash">${this._escapeHtml(commit.shortHash)}</code>
            <span class="commit-message">${this._escapeHtml(commit.message)}</span>
            ${filesHtml ? `<div class="commit-files">${filesHtml}</div>` : ''}
          </div>`;
      }
      commitsHtml += `</div>`;
    }
    
    return `
    <div class="section">
      <h3>Work Summary</h3>
      <div class="work-summary-stats">
        <div class="work-stat">
          <div class="work-stat-value">${ws.commits}</div>
          <div class="work-stat-label">Commits</div>
        </div>
        <div class="work-stat added">
          <div class="work-stat-value">+${ws.filesAdded}</div>
          <div class="work-stat-label">Added</div>
        </div>
        <div class="work-stat modified">
          <div class="work-stat-value">~${ws.filesModified}</div>
          <div class="work-stat-label">Modified</div>
        </div>
        <div class="work-stat deleted">
          <div class="work-stat-value">-${ws.filesDeleted}</div>
          <div class="work-stat-label">Deleted</div>
        </div>
      </div>
      ${ws.description ? `<div class="work-summary-desc">${this._escapeHtml(ws.description)}</div>` : ''}
      ${commitsHtml}
    </div>
    `;
  }
  
  /**
   * Build HTML summary of a child Plan's execution results
   */
  private _buildchildPlanSummaryHtml(childPlanId: string): string {
    const childPlan = this._planRunner.get(childPlanId);
    if (!childPlan) {
      return '';
    }
    
    // Count job statuses
    let succeeded = 0, failed = 0, blocked = 0, running = 0, pending = 0;
    const jobResults: Array<{name: string; status: string; error?: string; commit?: string}> = [];
    
    for (const [nodeId, state] of childPlan.nodeStates) {
      const node = childPlan.nodes.get(nodeId);
      if (state.status === 'succeeded') succeeded++;
      else if (state.status === 'failed') failed++;
      else if (state.status === 'blocked') blocked++;
      else if (state.status === 'running') running++;
      else pending++;
      
      jobResults.push({
        name: node?.name || nodeId.slice(0, 8),
        status: state.status,
        error: state.error,
        commit: state.completedCommit?.slice(0, 8),
      });
    }
    
    const total = childPlan.nodes.size;
    const ws = childPlan.workSummary;
    
    return `
    <div class="section">
      <h3>Child Plan Results</h3>
      <div class="work-summary-stats">
        <div class="work-stat">
          <div class="work-stat-value">${total}</div>
          <div class="work-stat-label">Jobs</div>
        </div>
        <div class="work-stat added">
          <div class="work-stat-value">${succeeded}</div>
          <div class="work-stat-label">Succeeded</div>
        </div>
        <div class="work-stat deleted">
          <div class="work-stat-value">${failed}</div>
          <div class="work-stat-label">Failed</div>
        </div>
        <div class="work-stat">
          <div class="work-stat-value">${blocked}</div>
          <div class="work-stat-label">Blocked</div>
        </div>
      </div>
      ${ws ? `
      <div class="child-plan-work" style="margin-top: 12px; padding: 8px; background: var(--vscode-sideBar-background); border-radius: 4px;">
        <span style="color: var(--vscode-descriptionForeground);">Work:</span>
        <span>${ws.totalCommits} commits</span>
        <span style="color: #4ec9b0;">+${ws.totalFilesAdded}</span>
        <span style="color: #dcdcaa;">~${ws.totalFilesModified}</span>
        <span style="color: #f48771;">-${ws.totalFilesDeleted}</span>
      </div>
      ` : ''}
      <div class="child-plan-jobs" style="margin-top: 12px;">
        ${jobResults.map(j => `
          <div class="child-job-row" style="display: flex; align-items: center; padding: 4px 0; border-bottom: 1px solid var(--vscode-widget-border);">
            <span class="status-icon" style="margin-right: 8px;">${
              j.status === 'succeeded' ? '✓' : 
              j.status === 'failed' ? '✗' : 
              j.status === 'blocked' ? '⊘' :
              j.status === 'running' ? '◐' : '○'
            }</span>
            <span style="flex: 1; ${j.status === 'failed' ? 'color: #f48771;' : ''}">${this._escapeHtml(j.name)}</span>
            ${j.commit ? `<span class="mono" style="font-size: 11px; color: var(--vscode-descriptionForeground);">${j.commit}</span>` : ''}
          </div>
          ${j.error ? `<div style="font-size: 11px; color: #f48771; padding-left: 24px; margin-bottom: 4px;">${this._escapeHtml(j.error.slice(0, 100))}${j.error.length > 100 ? '...' : ''}</div>` : ''}
        `).join('')}
      </div>
    </div>
    `;
  }
  
  /**
   * Build attempt history HTML with collapsible cards
   */
  private _buildAttemptHistoryHtml(state: NodeExecutionState): string {
    const attempts = state.attemptHistory;
    if (!attempts || attempts.length === 0) {
      return '';
    }
    
    // Build cards in reverse order (latest first)
    const cards = attempts.slice().reverse().map((attempt, reverseIdx) => {
      const isLatest = reverseIdx === 0;
      const duration = this._formatDuration(Math.round((attempt.endedAt - attempt.startedAt) / 1000));
      const timestamp = new Date(attempt.startedAt).toLocaleString();
      
      // Step indicators
      const stepDot = (status?: string): string => {
        const map: Record<string, string> = {
          'success': '<span class="step-dot success">●</span>',
          'failed': '<span class="step-dot failed">●</span>',
          'running': '<span class="step-dot running">●</span>',
          'skipped': '<span class="step-dot skipped">○</span>',
        };
        return map[status || ''] || '<span class="step-dot pending">○</span>';
      };
      
      const stepIndicators = `
        ${stepDot(attempt.stepStatuses?.prechecks)}
        ${stepDot(attempt.stepStatuses?.work)}
        ${stepDot(attempt.stepStatuses?.commit)}
        ${stepDot(attempt.stepStatuses?.postchecks)}
      `;
      
      const sessionHtml = attempt.copilotSessionId
        ? `<div class="attempt-meta-row"><strong>Session:</strong> <span class="session-id" data-session="${attempt.copilotSessionId}" title="Click to copy">${attempt.copilotSessionId.substring(0, 12)}... 📋</span></div>`
        : '';
      
      const errorHtml = attempt.error
        ? `<div class="attempt-error">
            <strong>Error:</strong> ${this._escapeHtml(attempt.error)}
            ${attempt.failedPhase ? `<div style="margin-top: 4px;">Failed in phase: <strong>${attempt.failedPhase}</strong></div>` : ''}
            ${attempt.exitCode !== undefined ? `<div>Exit code: <strong>${attempt.exitCode}</strong></div>` : ''}
           </div>`
        : '';
      
      // Context details (worktree, base commit, work used)
      const contextHtml = (attempt.worktreePath || attempt.baseCommit || attempt.workUsed) 
        ? `<div class="attempt-context">
            ${attempt.baseCommit ? `<div class="attempt-meta-row"><strong>Base:</strong> <code>${attempt.baseCommit.slice(0, 8)}</code></div>` : ''}
            ${attempt.worktreePath ? `<div class="attempt-meta-row"><strong>Worktree:</strong> <code>${this._escapeHtml(attempt.worktreePath)}</code></div>` : ''}
            ${attempt.workUsed ? `<div class="attempt-meta-row"><strong>Work:</strong> <code>${this._escapeHtml(formatWorkSpec(attempt.workUsed))}</code></div>` : ''}
           </div>`
        : '';
      
      // Build phase tabs for this attempt
      const phaseTabsHtml = attempt.logs ? this._buildAttemptPhaseTabs(attempt) : '';
      
      return `
        <div class="attempt-card ${isLatest ? 'active' : ''}" data-attempt="${attempt.attemptNumber}">
          <div class="attempt-header" data-expanded="${isLatest}">
            <div class="attempt-header-left">
              <span class="attempt-badge">#${attempt.attemptNumber}</span>
              <span class="step-indicators">${stepIndicators}</span>
              <span class="attempt-time">${timestamp}</span>
              <span class="attempt-duration">(${duration})</span>
            </div>
            <span class="chevron ${isLatest ? 'expanded' : ''}">${isLatest ? '▼' : '▶'}</span>
          </div>
          <div class="attempt-body" style="display: ${isLatest ? 'block' : 'none'};">
            <div class="attempt-meta">
              <div class="attempt-meta-row"><strong>Status:</strong> <span class="status-${attempt.status}">${attempt.status}</span></div>
              ${sessionHtml}
            </div>
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
   * Build phase tabs for a specific attempt
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
        <pre class="attempt-log-viewer" data-attempt="${attempt.attemptNumber}">${this._escapeHtml(phaseLogsData['all'])}</pre>
        <script type="application/json" class="attempt-logs-data" data-attempt="${attempt.attemptNumber}">
          ${JSON.stringify(phaseLogsData)}
        </script>
      </div>
    `;
  }
  
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
    
    /* Error */
    .error-box {
      background: rgba(244, 135, 113, 0.1);
      border: 1px solid rgba(244, 135, 113, 0.3);
      border-radius: 6px;
      padding: 10px;
      margin-top: 12px;
      color: #f48771;
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
    .step-indicators {
      display: flex;
      gap: 4px;
    }
    .step-dot { font-size: 14px; }
    .step-dot.success { color: var(--vscode-testing-iconPassed); }
    .step-dot.failed { color: var(--vscode-errorForeground); }
    .step-dot.skipped { color: #808080; }
    .step-dot.pending { color: var(--vscode-descriptionForeground); opacity: 0.5; }
    .step-dot.running { color: #7DD3FC; animation: pulse-dot 1.5s ease-in-out infinite; }
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
    .attempt-context {
      margin-top: 8px;
      padding: 8px;
      background: var(--vscode-sideBar-background);
      border-radius: 4px;
      font-size: 11px;
    }
    .attempt-context code {
      background: rgba(255, 255, 255, 0.05);
      padding: 1px 4px;
      border-radius: 2px;
      font-family: var(--vscode-editor-font-family);
      font-size: 10px;
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
    `;
  }
  
  private _formatDuration(seconds: number): string {
    if (seconds < 0) return '0s';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    const parts: string[] = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
    return parts.join(' ');
  }
  
  private _escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
