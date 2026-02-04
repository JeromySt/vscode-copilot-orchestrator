/**
 * @fileoverview DAG Detail Panel
 * 
 * Shows detailed view of a DAG with:
 * - Mermaid diagram of the DAG structure
 * - Node status with real-time updates
 * - Progress tracking
 * - Actions (cancel, etc.)
 * 
 * @module ui/panels/dagDetailPanel
 */

import * as vscode from 'vscode';
import { DagRunner, DagInstance, DagNode, JobNode, SubDagNode, NodeStatus } from '../../dag';

/**
 * DAG Detail Panel - shows DAG execution flow
 */
export class DagDetailPanel {
  private static panels = new Map<string, DagDetailPanel>();
  
  private readonly _panel: vscode.WebviewPanel;
  private _dagId: string;
  private _disposables: vscode.Disposable[] = [];
  private _updateInterval?: NodeJS.Timeout;
  
  private constructor(
    panel: vscode.WebviewPanel,
    dagId: string,
    private _dagRunner: DagRunner
  ) {
    this._panel = panel;
    this._dagId = dagId;
    
    // Initial render
    this._update();
    
    // Setup update interval
    this._updateInterval = setInterval(() => this._update(), 1000);
    
    // Handle panel disposal
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    
    // Handle messages from webview
    this._panel.webview.onDidReceiveMessage(
      message => this._handleMessage(message),
      null,
      this._disposables
    );
  }
  
  public static createOrShow(
    extensionUri: vscode.Uri,
    dagId: string,
    dagRunner: DagRunner
  ) {
    // Check if panel already exists
    const existing = DagDetailPanel.panels.get(dagId);
    if (existing) {
      existing._panel.reveal();
      return;
    }
    
    const dag = dagRunner.get(dagId);
    const title = dag ? `DAG: ${dag.spec.name}` : `DAG: ${dagId.slice(0, 8)}`;
    
    // Create new panel
    const panel = vscode.window.createWebviewPanel(
      'dagDetail',
      title,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );
    
    const dagPanel = new DagDetailPanel(panel, dagId, dagRunner);
    DagDetailPanel.panels.set(dagId, dagPanel);
  }
  
  public dispose() {
    DagDetailPanel.panels.delete(this._dagId);
    
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
      case 'cancel':
        vscode.commands.executeCommand('orchestrator.cancelDag', this._dagId);
        break;
      case 'openNode':
        vscode.commands.executeCommand('orchestrator.showNodeDetails', this._dagId, message.nodeId);
        break;
      case 'openSubDag':
        DagDetailPanel.createOrShow(
          this._panel.webview.cspSource as any,
          message.dagId,
          this._dagRunner
        );
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
    
    const sm = this._dagRunner.getStateMachine(this._dagId);
    const status = sm?.computeDagStatus() || 'pending';
    const defaultCounts: Record<NodeStatus, number> = {
      pending: 0, ready: 0, scheduled: 0, running: 0,
      succeeded: 0, failed: 0, blocked: 0, canceled: 0
    };
    const counts = sm?.getStatusCounts() || defaultCounts;
    
    this._panel.webview.html = this._getHtml(dag, status, counts);
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
    status: string,
    counts: Record<NodeStatus, number>
  ): string {
    const total = dag.nodes.size;
    const completed = (counts.succeeded || 0) + (counts.failed || 0) + (counts.blocked || 0);
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
    
    // Build Mermaid diagram
    const mermaidDef = this._buildMermaidDiagram(dag);
    
    // Build node data for click handling
    const nodeData: Record<string, { nodeId: string; type: string; childDagId?: string }> = {};
    for (const [nodeId, node] of dag.nodes) {
      nodeData[this._sanitizeId(nodeId)] = {
        nodeId,
        type: node.type,
        childDagId: node.type === 'subdag' ? (node as SubDagNode).childDagId : undefined,
      };
    }
    
    // Get branch info
    const baseBranch = dag.spec.baseBranch || 'main';
    const targetBranch = dag.targetBranch || baseBranch;
    const showBranchFlow = baseBranch !== targetBranch || dag.targetBranch;
    
    // Build work summary from node states
    const workSummaryHtml = this._buildWorkSummaryHtml(dag);
    
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
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
      margin-bottom: 12px;
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
    .status-badge.partial { background: rgba(255, 204, 0, 0.2); color: #cca700; }
    .status-badge.pending { background: rgba(133, 133, 133, 0.2); color: #858585; }
    
    /* Branch flow */
    .branch-flow {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 16px;
      padding: 10px 14px;
      background: var(--vscode-sideBar-background);
      border-radius: 6px;
      font-size: 12px;
    }
    .branch-name {
      padding: 3px 8px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 4px;
      font-family: monospace;
    }
    .branch-arrow {
      color: var(--vscode-descriptionForeground);
    }
    .branch-label {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    
    .stats {
      display: flex;
      gap: 16px;
      margin-bottom: 16px;
      padding: 12px;
      background: var(--vscode-sideBar-background);
      border-radius: 8px;
    }
    .stat {
      text-align: center;
    }
    .stat-value {
      font-size: 24px;
      font-weight: 600;
    }
    .stat-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .stat-value.succeeded { color: #4ec9b0; }
    .stat-value.failed { color: #f48771; }
    .stat-value.running { color: #3794ff; }
    
    .progress-container {
      margin-bottom: 16px;
    }
    .progress-bar {
      height: 6px;
      background: var(--vscode-progressBar-background);
      opacity: 0.3;
      border-radius: 3px;
    }
    .progress-fill {
      height: 100%;
      background: var(--vscode-progressBar-background);
      border-radius: 3px;
      transition: width 0.3s ease;
    }
    .progress-fill.succeeded { background: #4ec9b0; }
    .progress-fill.failed { background: #f48771; }
    
    #mermaid-diagram {
      background: var(--vscode-sideBar-background);
      padding: 16px;
      border-radius: 8px;
      overflow: auto;
      margin-bottom: 16px;
    }
    
    /* Mermaid node styling */
    .mermaid .node rect { rx: 8px; ry: 8px; }
    .mermaid .node.pending rect { fill: #3c3c3c; stroke: #858585; }
    .mermaid .node.ready rect { fill: #2d4a6e; stroke: #3794ff; }
    .mermaid .node.running rect { fill: #2d4a6e; stroke: #3794ff; stroke-width: 2px; }
    .mermaid .node.succeeded rect { fill: #1e4d40; stroke: #4ec9b0; }
    .mermaid .node.failed rect { fill: #4d2929; stroke: #f48771; }
    .mermaid .node.blocked rect { fill: #3c3c3c; stroke: #858585; stroke-dasharray: 5,5; }
    
    .mermaid .node { cursor: pointer; }
    
    /* Work Summary */
    .work-summary {
      background: var(--vscode-sideBar-background);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
    }
    .work-summary h3 {
      margin: 0 0 12px 0;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
    }
    .work-summary-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 16px;
    }
    .work-stat {
      text-align: center;
      padding: 12px;
      background: var(--vscode-editor-background);
      border-radius: 6px;
    }
    .work-stat-value {
      font-size: 20px;
      font-weight: 600;
    }
    .work-stat-value.added { color: #4ec9b0; }
    .work-stat-value.modified { color: #dcdcaa; }
    .work-stat-value.deleted { color: #f48771; }
    .work-stat-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
    }
    
    .job-summaries {
      border-top: 1px solid var(--vscode-widget-border);
      padding-top: 12px;
    }
    .job-summary {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid var(--vscode-widget-border);
      cursor: pointer;
    }
    .job-summary:hover {
      background: var(--vscode-list-hoverBackground);
      margin: 0 -8px;
      padding: 8px;
    }
    .job-summary:last-child { border-bottom: none; }
    .job-name {
      font-weight: 500;
    }
    .job-stats {
      display: flex;
      gap: 12px;
      font-size: 12px;
    }
    .job-stats .stat-commits { color: var(--vscode-descriptionForeground); }
    .job-stats .stat-added { color: #4ec9b0; }
    .job-stats .stat-modified { color: #dcdcaa; }
    .job-stats .stat-deleted { color: #f48771; }
    
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
    }
    .action-btn.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .action-btn.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .action-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  </style>
</head>
<body>
  <div class="header">
    <h2>${this._escapeHtml(dag.spec.name)}</h2>
    <span class="status-badge ${status}">${status}</span>
  </div>
  
  ${showBranchFlow ? `
  <div class="branch-flow">
    <span class="branch-label">Base:</span>
    <span class="branch-name">${this._escapeHtml(baseBranch)}</span>
    <span class="branch-arrow">→</span>
    <span class="branch-label">Work</span>
    <span class="branch-arrow">→</span>
    <span class="branch-label">Target:</span>
    <span class="branch-name">${this._escapeHtml(targetBranch)}</span>
  </div>
  ` : ''}
  
  <div class="stats">
    <div class="stat">
      <div class="stat-value">${total}</div>
      <div class="stat-label">Total Nodes</div>
    </div>
    <div class="stat">
      <div class="stat-value succeeded">${counts.succeeded || 0}</div>
      <div class="stat-label">Succeeded</div>
    </div>
    <div class="stat">
      <div class="stat-value failed">${counts.failed || 0}</div>
      <div class="stat-label">Failed</div>
    </div>
    <div class="stat">
      <div class="stat-value running">${(counts.running || 0) + (counts.scheduled || 0)}</div>
      <div class="stat-label">Running</div>
    </div>
    <div class="stat">
      <div class="stat-value">${(counts.pending || 0) + (counts.ready || 0)}</div>
      <div class="stat-label">Pending</div>
    </div>
  </div>
  
  <div class="progress-container">
    <div class="progress-bar">
      <div class="progress-fill ${status === 'failed' ? 'failed' : status === 'succeeded' ? 'succeeded' : ''}" 
           style="width: ${progress}%"></div>
    </div>
  </div>
  
  <div id="mermaid-diagram">
    <pre class="mermaid">
${mermaidDef}
    </pre>
  </div>
  
  ${workSummaryHtml}
  
  <div class="actions">
    ${status === 'running' || status === 'pending' ? 
      '<button class="action-btn secondary" onclick="cancelDag()">Cancel</button>' : ''}
    <button class="action-btn secondary" onclick="refresh()">Refresh</button>
    ${status === 'succeeded' ? 
      '<button class="action-btn primary" onclick="showWorkSummary()">View Work Summary</button>' : ''}
  </div>
  
  <script>
    const vscode = acquireVsCodeApi();
    const nodeData = ${JSON.stringify(nodeData)};
    
    mermaid.initialize({
      startOnLoad: true,
      theme: 'dark',
      flowchart: {
        useMaxWidth: true,
        htmlLabels: true,
        curve: 'basis'
      }
    });
    
    // Handle node clicks
    document.addEventListener('click', (e) => {
      let el = e.target;
      while (el && el !== document.body) {
        if (el.classList && el.classList.contains('node')) {
          const nodeGroup = el.closest('g[id]');
          if (nodeGroup) {
            const match = nodeGroup.id.match(/flowchart-([^-]+)-/);
            if (match) {
              const sanitizedId = match[1];
              const data = nodeData[sanitizedId];
              if (data) {
                if (data.type === 'subdag' && data.childDagId) {
                  vscode.postMessage({ type: 'openSubDag', dagId: data.childDagId });
                } else {
                  vscode.postMessage({ type: 'openNode', nodeId: data.nodeId });
                }
              }
            }
          }
          break;
        }
        el = el.parentElement;
      }
    });
    
    // Handle job summary clicks
    document.querySelectorAll('.job-summary').forEach(el => {
      el.addEventListener('click', () => {
        const nodeId = el.dataset.nodeId;
        if (nodeId) {
          vscode.postMessage({ type: 'openNode', nodeId });
        }
      });
    });
    
    function cancelDag() {
      vscode.postMessage({ type: 'cancel' });
    }
    
    function refresh() {
      vscode.postMessage({ type: 'refresh' });
    }
    
    function showWorkSummary() {
      vscode.postMessage({ type: 'showWorkSummary' });
    }
  </script>
</body>
</html>`;
  }
  
  /**
   * Build work summary HTML from node execution states
   */
  private _buildWorkSummaryHtml(dag: DagInstance): string {
    // Count totals across all nodes
    let totalCommits = 0;
    let totalAdded = 0;
    let totalModified = 0;
    let totalDeleted = 0;
    
    const jobSummaries: Array<{
      nodeId: string;
      name: string;
      commits: number;
      added: number;
      modified: number;
      deleted: number;
    }> = [];
    
    for (const [nodeId, node] of dag.nodes) {
      if (node.type !== 'job') continue;
      
      const state = dag.nodeStates.get(nodeId);
      if (!state || state.status !== 'succeeded') continue;
      
      const ws = state.workSummary;
      if (!ws) continue;
      
      const commits = ws.commits || 0;
      const added = ws.filesAdded || 0;
      const modified = ws.filesModified || 0;
      const deleted = ws.filesDeleted || 0;
      
      totalCommits += commits;
      totalAdded += added;
      totalModified += modified;
      totalDeleted += deleted;
      
      if (commits > 0 || added > 0 || modified > 0 || deleted > 0) {
        jobSummaries.push({
          nodeId,
          name: node.name,
          commits,
          added,
          modified,
          deleted,
        });
      }
    }
    
    // Don't show if no work done
    if (totalCommits === 0 && totalAdded === 0 && totalModified === 0 && totalDeleted === 0) {
      return '';
    }
    
    const jobSummariesHtml = jobSummaries.map(j => `
      <div class="job-summary" data-node-id="${j.nodeId}">
        <span class="job-name">${this._escapeHtml(j.name)}</span>
        <span class="job-stats">
          <span class="stat-commits">${j.commits} commits</span>
          <span class="stat-added">+${j.added}</span>
          <span class="stat-modified">~${j.modified}</span>
          <span class="stat-deleted">-${j.deleted}</span>
        </span>
      </div>
    `).join('');
    
    return `
    <div class="work-summary">
      <h3>Work Summary</h3>
      <div class="work-summary-grid">
        <div class="work-stat">
          <div class="work-stat-value">${totalCommits}</div>
          <div class="work-stat-label">Commits</div>
        </div>
        <div class="work-stat">
          <div class="work-stat-value added">+${totalAdded}</div>
          <div class="work-stat-label">Files Added</div>
        </div>
        <div class="work-stat">
          <div class="work-stat-value modified">~${totalModified}</div>
          <div class="work-stat-label">Modified</div>
        </div>
        <div class="work-stat">
          <div class="work-stat-value deleted">-${totalDeleted}</div>
          <div class="work-stat-label">Deleted</div>
        </div>
      </div>
      ${jobSummaries.length > 0 ? `
      <div class="job-summaries">
        ${jobSummariesHtml}
      </div>
      ` : ''}
    </div>
    `;
  }
  
  private _buildMermaidDiagram(dag: DagInstance): string {
    const lines: string[] = ['flowchart LR'];
    
    // Add style definitions
    lines.push('  classDef pending fill:#3c3c3c,stroke:#858585');
    lines.push('  classDef ready fill:#2d4a6e,stroke:#3794ff');
    lines.push('  classDef running fill:#2d4a6e,stroke:#3794ff,stroke-width:2px');
    lines.push('  classDef succeeded fill:#1e4d40,stroke:#4ec9b0');
    lines.push('  classDef failed fill:#4d2929,stroke:#f48771');
    lines.push('  classDef blocked fill:#3c3c3c,stroke:#858585,stroke-dasharray:5');
    lines.push('');
    
    // Add nodes
    for (const [nodeId, node] of dag.nodes) {
      const sanitizedId = this._sanitizeId(nodeId);
      const state = dag.nodeStates.get(nodeId);
      const status = state?.status || 'pending';
      
      const label = this._escapeForMermaid(node.name);
      const shape = node.type === 'subdag' ? `{{${label}}}` : `[${label}]`;
      
      lines.push(`  ${sanitizedId}${shape}`);
      lines.push(`  class ${sanitizedId} ${status}`);
    }
    
    lines.push('');
    
    // Add edges
    for (const [nodeId, node] of dag.nodes) {
      const sanitizedId = this._sanitizeId(nodeId);
      
      for (const depId of node.dependencies) {
        const sanitizedDepId = this._sanitizeId(depId);
        lines.push(`  ${sanitizedDepId} --> ${sanitizedId}`);
      }
    }
    
    return lines.join('\n');
  }
  
  private _sanitizeId(id: string): string {
    return 'node_' + id.replace(/[^a-zA-Z0-9]/g, '_');
  }
  
  private _escapeForMermaid(str: string): string {
    return str
      .replace(/"/g, "'")
      .replace(/[<>{}|]/g, '')
      .slice(0, 40);
  }
  
  private _escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
