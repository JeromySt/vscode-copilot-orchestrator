/**
 * @fileoverview Node Detail Panel
 * 
 * Shows detailed view of a single node including:
 * - Execution state with phase tabs
 * - Log viewer with live streaming
 * - Work summary with commit details
 * - Process tree for running jobs
 * 
 * Ported from the legacy Job Details panel to work with DAG nodes.
 * 
 * @module ui/panels/nodeDetailPanel
 */

import * as vscode from 'vscode';
import { DagRunner, DagInstance, JobNode, SubDagNode, NodeExecutionState, JobWorkSummary } from '../../dag';
import { getJobDetailsCss } from '../templates/jobDetailsCss';
import { getJobDetailsJs } from '../templates/jobDetailsJs';

/**
 * Node Detail Panel - shows job/node execution details with logs
 */
export class NodeDetailPanel {
  private static panels = new Map<string, NodeDetailPanel>();
  
  private readonly _panel: vscode.WebviewPanel;
  private _dagId: string;
  private _nodeId: string;
  private _disposables: vscode.Disposable[] = [];
  private _updateInterval?: NodeJS.Timeout;
  
  private constructor(
    panel: vscode.WebviewPanel,
    dagId: string,
    nodeId: string,
    private _dagRunner: DagRunner
  ) {
    this._panel = panel;
    this._dagId = dagId;
    this._nodeId = nodeId;
    
    // Show loading state immediately
    this._panel.webview.html = this._getLoadingHtml();
    
    // Initial render (deferred)
    setImmediate(() => this._update());
    
    // Setup update interval for running nodes
    this._updateInterval = setInterval(() => {
      const dag = this._dagRunner.get(this._dagId);
      const state = dag?.nodeStates.get(this._nodeId);
      if (state?.status === 'running' || state?.status === 'scheduled') {
        this._update();
      }
    }, 1000);
    
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
    dagId: string,
    nodeId: string,
    dagRunner: DagRunner
  ) {
    const key = `${dagId}:${nodeId}`;
    
    const existing = NodeDetailPanel.panels.get(key);
    if (existing) {
      existing._panel.reveal();
      existing._update();
      return;
    }
    
    const dag = dagRunner.get(dagId);
    const node = dag?.nodes.get(nodeId);
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
    
    const nodePanel = new NodeDetailPanel(panel, dagId, nodeId, dagRunner);
    NodeDetailPanel.panels.set(key, nodePanel);
  }
  
  public dispose() {
    const key = `${this._dagId}:${this._nodeId}`;
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
      case 'openDag':
        vscode.commands.executeCommand('orchestrator.showDagDetails', message.dagId);
        break;
      case 'openWorktree':
        const dag = this._dagRunner.get(this._dagId);
        const state = dag?.nodeStates.get(this._nodeId);
        if (state?.worktreePath) {
          vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(state.worktreePath), { forceNewWindow: true });
        }
        break;
      case 'refresh':
        this._update();
        break;
      case 'getLog':
        this._sendLog(message.phase);
        break;
    }
  }
  
  private async _sendLog(phase: string) {
    const dag = this._dagRunner.get(this._dagId);
    const node = dag?.nodes.get(this._nodeId);
    if (!node || node.type !== 'job') return;
    
    // Get logs from executor
    const logs = this._dagRunner.getNodeLogs(this._dagId, this._nodeId, phase as any);
    
    this._panel.webview.postMessage({
      type: 'logContent',
      phase,
      content: logs || 'No logs available for this phase.'
    });
  }
  
  private _update() {
    const dag = this._dagRunner.get(this._dagId);
    if (!dag) {
      this._panel.webview.html = this._getErrorHtml('DAG not found');
      return;
    }
    
    const node = dag.nodes.get(this._nodeId);
    const state = dag.nodeStates.get(this._nodeId);
    
    if (!node || !state) {
      this._panel.webview.html = this._getErrorHtml('Node not found');
      return;
    }
    
    this._panel.webview.html = this._getHtml(dag, node, state);
  }
  
  private _getLoadingHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
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
<head><meta charset="UTF-8"></head>
<body style="padding: 20px; color: var(--vscode-errorForeground);">
  <h2>Error</h2>
  <p>${message}</p>
</body>
</html>`;
  }
  
  private _getHtml(
    dag: DagInstance,
    node: JobNode | SubDagNode,
    state: NodeExecutionState
  ): string {
    const isJob = node.type === 'job';
    const jobNode = isJob ? node as JobNode : null;
    const subDagNode = !isJob ? node as SubDagNode : null;
    
    const duration = state.startedAt 
      ? this._formatDuration(Math.round(((state.endedAt || Date.now()) - state.startedAt) / 1000))
      : null;
    
    // Build phase status indicators
    const phaseStatus = this._getPhaseStatus(state);
    
    // Build work summary HTML
    const workSummaryHtml = state.workSummary 
      ? this._buildWorkSummaryHtml(state.workSummary)
      : '';
    
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    ${this._getStyles()}
  </style>
</head>
<body>
  <div class="breadcrumb">
    <a onclick="openDag('${dag.id}')">${this._escapeHtml(dag.spec.name)}</a> / ${this._escapeHtml(node.name)}
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
        <div class="meta-value">${node.type === 'job' ? 'Job' : 'Sub-DAG'}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Attempts</div>
        <div class="meta-value">${state.attempts}</div>
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
    </div>
    ${state.error ? `
    <div class="error-box">
      <strong>Error:</strong> ${this._escapeHtml(state.error)}
    </div>
    ` : ''}
  </div>
  
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
      <div class="config-value mono">${this._escapeHtml(jobNode.work)}</div>
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
  
  ${subDagNode ? `
  <!-- Sub-DAG Info -->
  <div class="section">
    <h3>Sub-DAG Configuration</h3>
    <div class="config-item">
      <div class="config-label">Jobs</div>
      <div class="config-value">${subDagNode.childSpec.jobs.length} jobs defined</div>
    </div>
    ${subDagNode.childDagId ? `
    <div class="config-item">
      <div class="config-label">Child DAG</div>
      <div class="config-value">
        <a onclick="openDag('${subDagNode.childDagId}')" class="link">${subDagNode.childDagId.slice(0, 8)}...</a>
      </div>
    </div>
    ` : ''}
  </div>
  ` : ''}
  
  <!-- Dependencies -->
  <div class="section">
    <h3>Dependencies</h3>
    ${node.dependencies.length > 0 ? `
    <div class="deps-list">
      ${node.dependencies.map(depId => {
        const depNode = dag.nodes.get(depId);
        const depState = dag.nodeStates.get(depId);
        return `<span class="dep-badge ${depState?.status || 'pending'}">${this._escapeHtml(depNode?.name || depId)}</span>`;
      }).join('')}
    </div>
    ` : '<div class="config-value">No dependencies (root node)</div>'}
  </div>
  
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
      <div class="config-label">Worktree (detached HEAD)</div>
      <div class="config-value mono">${this._escapeHtml(state.worktreePath)}</div>
    </div>
    ` : ''}
  </div>
  ` : ''}
  
  <!-- Actions -->
  <div class="actions">
    ${state.worktreePath ? '<button class="action-btn" onclick="openWorktree()">Open Worktree</button>' : ''}
    <button class="action-btn" onclick="refresh()">Refresh</button>
  </div>
  
  <script>
    const vscode = acquireVsCodeApi();
    let currentPhase = null;
    
    function openDag(dagId) {
      vscode.postMessage({ type: 'openDag', dagId });
    }
    
    function openWorktree() {
      vscode.postMessage({ type: 'openWorktree' });
    }
    
    function refresh() {
      vscode.postMessage({ type: 'refresh' });
    }
    
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
        viewer.innerHTML = '<pre class="log-content">' + escapeHtml(msg.content) + '</pre>';
        viewer.scrollTop = viewer.scrollHeight;
      }
    });
    
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
    // Derive phase status from execution state
    // For now, simplified - in production would track per-phase
    const status = state.status;
    
    if (status === 'succeeded') {
      return {
        prechecks: 'success',
        work: 'success',
        commit: 'success',
        postchecks: 'success',
      };
    } else if (status === 'failed') {
      return {
        prechecks: 'success',
        work: 'failed',
        commit: 'pending',
        postchecks: 'pending',
      };
    } else if (status === 'running') {
      return {
        prechecks: 'success',
        work: 'running',
        commit: 'pending',
        postchecks: 'pending',
      };
    }
    
    return {
      prechecks: 'pending',
      work: 'pending',
      commit: 'pending',
      postchecks: 'pending',
    };
  }
  
  private _buildPhaseTabs(phaseStatus: Record<string, string>, isRunning: boolean): string {
    const phases = [
      { id: 'all', name: 'Full Log', icon: '📋' },
      { id: 'prechecks', name: 'Prechecks', icon: this._getPhaseIcon(phaseStatus.prechecks) },
      { id: 'work', name: 'Work', icon: this._getPhaseIcon(phaseStatus.work) },
      { id: 'commit', name: 'Commit', icon: this._getPhaseIcon(phaseStatus.commit) },
      { id: 'postchecks', name: 'Postchecks', icon: this._getPhaseIcon(phaseStatus.postchecks) },
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
  
  private _buildWorkSummaryHtml(ws: JobWorkSummary): string {
    if (!ws || (ws.commits === 0 && ws.filesAdded === 0 && ws.filesModified === 0 && ws.filesDeleted === 0)) {
      return '';
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
