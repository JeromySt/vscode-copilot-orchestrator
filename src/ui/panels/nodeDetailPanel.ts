/**
 * @fileoverview Node Detail Panel
 * 
 * Shows detailed view of a single node including:
 * - Node configuration
 * - Execution state
 * - Logs (when available)
 * - Work summary
 * 
 * @module ui/panels/nodeDetailPanel
 */

import * as vscode from 'vscode';
import { DagRunner, DagInstance, JobNode, SubDagNode, NodeExecutionState } from '../../dag';

/**
 * Node Detail Panel - shows job/node execution details
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
    
    // Initial render
    this._update();
    
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
    }
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
      ? Math.round(((state.endedAt || Date.now()) - state.startedAt) / 1000)
      : null;
    
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font: 13px var(--vscode-font-family);
      padding: 16px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .header h2 { margin: 0; }
    .status-badge {
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .status-badge.running { background: rgba(0, 122, 204, 0.2); color: #3794ff; }
    .status-badge.succeeded { background: rgba(78, 201, 176, 0.2); color: #4ec9b0; }
    .status-badge.failed { background: rgba(244, 135, 113, 0.2); color: #f48771; }
    .status-badge.pending { background: rgba(133, 133, 133, 0.2); color: #858585; }
    .status-badge.ready { background: rgba(0, 122, 204, 0.1); color: #3794ff; }
    .status-badge.blocked { background: rgba(133, 133, 133, 0.2); color: #858585; }
    .status-badge.scheduled { background: rgba(0, 122, 204, 0.2); color: #3794ff; }
    
    .section {
      margin-bottom: 20px;
      padding: 12px;
      background: var(--vscode-sideBar-background);
      border-radius: 8px;
    }
    .section h3 {
      margin: 0 0 12px 0;
      font-size: 13px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .field {
      margin-bottom: 8px;
    }
    .field-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 2px;
    }
    .field-value {
      font-family: var(--vscode-editor-font-family);
    }
    .field-value.mono {
      font-family: 'Consolas', 'Courier New', monospace;
      font-size: 12px;
      background: var(--vscode-textCodeBlock-background);
      padding: 4px 8px;
      border-radius: 4px;
    }
    .error-message {
      color: var(--vscode-errorForeground);
      background: rgba(244, 135, 113, 0.1);
      padding: 8px;
      border-radius: 4px;
      margin-top: 8px;
    }
    .breadcrumb {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }
    .breadcrumb a {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: none;
    }
    .breadcrumb a:hover {
      text-decoration: underline;
    }
    .actions {
      margin-top: 16px;
      display: flex;
      gap: 8px;
    }
    .action-btn {
      padding: 6px 12px;
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
    .deps-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .dep-badge {
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
  </style>
</head>
<body>
  <div class="breadcrumb">
    <a onclick="openDag('${dag.id}')">${this._escapeHtml(dag.spec.name)}</a> / ${this._escapeHtml(node.name)}
  </div>
  
  <div class="header">
    <h2>${this._escapeHtml(node.name)}</h2>
    <span class="status-badge ${state.status}">${state.status}</span>
  </div>
  
  <div class="section">
    <h3>Execution State</h3>
    <div class="field">
      <div class="field-label">Type</div>
      <div class="field-value">${node.type === 'job' ? 'Job' : 'Sub-DAG'}</div>
    </div>
    <div class="field">
      <div class="field-label">Attempts</div>
      <div class="field-value">${state.attempts}</div>
    </div>
    ${state.scheduledAt ? `
    <div class="field">
      <div class="field-label">Scheduled</div>
      <div class="field-value">${new Date(state.scheduledAt).toLocaleString()}</div>
    </div>
    ` : ''}
    ${state.startedAt ? `
    <div class="field">
      <div class="field-label">Started</div>
      <div class="field-value">${new Date(state.startedAt).toLocaleString()}</div>
    </div>
    ` : ''}
    ${state.endedAt ? `
    <div class="field">
      <div class="field-label">Ended</div>
      <div class="field-value">${new Date(state.endedAt).toLocaleString()}</div>
    </div>
    ` : ''}
    ${duration !== null ? `
    <div class="field">
      <div class="field-label">Duration</div>
      <div class="field-value">${duration}s</div>
    </div>
    ` : ''}
    ${state.error ? `
    <div class="error-message">
      <strong>Error:</strong> ${this._escapeHtml(state.error)}
    </div>
    ` : ''}
  </div>
  
  ${isJob && jobNode ? `
  <div class="section">
    <h3>Job Configuration</h3>
    <div class="field">
      <div class="field-label">Task</div>
      <div class="field-value">${this._escapeHtml(jobNode.task)}</div>
    </div>
    ${jobNode.work ? `
    <div class="field">
      <div class="field-label">Work</div>
      <div class="field-value mono">${this._escapeHtml(jobNode.work)}</div>
    </div>
    ` : ''}
    ${jobNode.prechecks ? `
    <div class="field">
      <div class="field-label">Prechecks</div>
      <div class="field-value mono">${this._escapeHtml(jobNode.prechecks)}</div>
    </div>
    ` : ''}
    ${jobNode.postchecks ? `
    <div class="field">
      <div class="field-label">Postchecks</div>
      <div class="field-value mono">${this._escapeHtml(jobNode.postchecks)}</div>
    </div>
    ` : ''}
  </div>
  ` : ''}
  
  ${subDagNode ? `
  <div class="section">
    <h3>Sub-DAG</h3>
    <div class="field">
      <div class="field-label">Jobs</div>
      <div class="field-value">${subDagNode.childSpec.jobs.length} jobs defined</div>
    </div>
    ${subDagNode.childDagId ? `
    <div class="field">
      <div class="field-label">Child DAG ID</div>
      <div class="field-value mono">${subDagNode.childDagId}</div>
    </div>
    ` : ''}
  </div>
  ` : ''}
  
  <div class="section">
    <h3>Dependencies</h3>
    ${node.dependencies.length > 0 ? `
    <div class="deps-list">
      ${node.dependencies.map(depId => {
        const depNode = dag.nodes.get(depId);
        return `<span class="dep-badge">${this._escapeHtml(depNode?.name || depId)}</span>`;
      }).join('')}
    </div>
    ` : '<div class="field-value">No dependencies (root node)</div>'}
  </div>
  
  ${state.worktreePath || state.branchName || state.completedCommit ? `
  <div class="section">
    <h3>Git Information</h3>
    ${state.worktreePath ? `
    <div class="field">
      <div class="field-label">Worktree</div>
      <div class="field-value mono">${this._escapeHtml(state.worktreePath)}</div>
    </div>
    ` : ''}
    ${state.branchName ? `
    <div class="field">
      <div class="field-label">Branch</div>
      <div class="field-value mono">${this._escapeHtml(state.branchName)}</div>
    </div>
    ` : ''}
    ${state.completedCommit ? `
    <div class="field">
      <div class="field-label">Commit</div>
      <div class="field-value mono">${state.completedCommit.slice(0, 12)}</div>
    </div>
    ` : ''}
  </div>
  ` : ''}
  
  <div class="actions">
    ${state.worktreePath ? '<button class="action-btn" onclick="openWorktree()">Open Worktree</button>' : ''}
    <button class="action-btn" onclick="refresh()">Refresh</button>
  </div>
  
  <script>
    const vscode = acquireVsCodeApi();
    
    function openDag(dagId) {
      vscode.postMessage({ type: 'openDag', dagId });
    }
    
    function openWorktree() {
      vscode.postMessage({ type: 'openWorktree' });
    }
    
    function refresh() {
      vscode.postMessage({ type: 'refresh' });
    }
  </script>
</body>
</html>`;
  }
  
  private _escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
