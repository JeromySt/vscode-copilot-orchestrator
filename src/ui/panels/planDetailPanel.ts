/**
 * @fileoverview Plan Detail Panel
 * 
 * Shows detailed view of a Plan with:
 * - Mermaid diagram of the Plan structure
 * - Node status with real-time updates
 * - Progress tracking
 * - Actions (cancel, etc.)
 * 
 * @module ui/panels/planDetailPanel
 */

import * as vscode from 'vscode';
import { PlanRunner, PlanInstance, PlanNode, JobNode, SubPlanNode, NodeStatus, NodeExecutionState } from '../../plan';

/**
 * Plan Detail Panel - shows Plan execution flow
 */
export class planDetailPanel {
  private static panels = new Map<string, planDetailPanel>();
  
  private readonly _panel: vscode.WebviewPanel;
  private _planId: string;
  private _disposables: vscode.Disposable[] = [];
  private _updateInterval?: NodeJS.Timeout;
  private _lastStateHash: string = '';
  
  private constructor(
    panel: vscode.WebviewPanel,
    planId: string,
    private _planRunner: PlanRunner
  ) {
    this._panel = panel;
    this._planId = planId;
    
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
    planId: string,
    planRunner: PlanRunner
  ) {
    // Check if panel already exists
    const existing = planDetailPanel.panels.get(planId);
    if (existing) {
      existing._panel.reveal();
      return;
    }
    
    const plan = planRunner.get(planId);
    const title = plan ? `Plan: ${plan.spec.name}` : `Plan: ${planId.slice(0, 8)}`;
    
    // Create new panel
    const panel = vscode.window.createWebviewPanel(
      'planDetail',
      title,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );
    
    const planPanel = new planDetailPanel(panel, planId, planRunner);
    planDetailPanel.panels.set(planId, planPanel);
  }
  
  /**
   * Close all panels associated with a Plan (used when Plan is deleted)
   */
  public static closeForPlan(planId: string): void {
    const panel = planDetailPanel.panels.get(planId);
    if (panel) {
      panel.dispose();
    }
  }
  
  public dispose() {
    planDetailPanel.panels.delete(this._planId);
    
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
        vscode.commands.executeCommand('orchestrator.cancelPlan', this._planId);
        break;
      case 'delete':
        vscode.commands.executeCommand('orchestrator.deletePlan', this._planId);
        break;
      case 'openNode':
        // Use the planId from the message if provided (for nodes in child Plans), otherwise use the main Plan ID
        const planIdForNode = message.planId || this._planId;
        vscode.commands.executeCommand('orchestrator.showNodeDetails', planIdForNode, message.nodeId);
        break;
      case 'opensubPlan':
        planDetailPanel.createOrShow(
          this._panel.webview.cspSource as any,
          message.planId,
          this._planRunner
        );
        break;
      case 'refresh':
        this._update();
        break;
      case 'showWorkSummary':
        // Show work summary in a new editor tab as markdown
        this._showWorkSummaryDocument();
        break;
      case 'getAllProcessStats':
        this._sendAllProcessStats();
        break;
    }
  }
  
  private async _sendAllProcessStats() {
    const stats = await this._planRunner.getAllProcessStats(this._planId);
    this._panel.webview.postMessage({
      type: 'allProcessStats',
      flat: (stats as any).flat || [],
      hierarchy: (stats as any).hierarchy || [],
      rootJobs: (stats as any).rootJobs || []
    });
  }
  
  /**
   * Show the work summary in a styled webview panel
   */
  private async _showWorkSummaryDocument(): Promise<void> {
    const plan = this._planRunner.get(this._planId);
    if (!plan || !plan.workSummary) {
      vscode.window.showInformationMessage('No work summary available');
      return;
    }
    
    const summary = plan.workSummary;
    
    // Build job details HTML
    let jobDetailsHtml = '';
    if (summary.jobSummaries && summary.jobSummaries.length > 0) {
      for (const job of summary.jobSummaries) {
        let commitsHtml = '';
        if (job.commitDetails && job.commitDetails.length > 0) {
          commitsHtml = `<div class="commits-list">`;
          for (const commit of job.commitDetails) {
            // Build files list with one file per line
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
        
        jobDetailsHtml += `
          <div class="job-card">
            <div class="job-header">
              <span class="job-name">${this._escapeHtml(job.nodeName)}</span>
              <span class="job-stats">
                <span class="stat-commits">${job.commits} commits</span>
                <span class="stat-added">+${job.filesAdded}</span>
                <span class="stat-modified">~${job.filesModified}</span>
                <span class="stat-deleted">-${job.filesDeleted}</span>
              </span>
            </div>
            <div class="job-description">${this._escapeHtml(job.description)}</div>
            ${commitsHtml}
          </div>`;
      }
    }
    
    // Create the webview panel
    const panel = vscode.window.createWebviewPanel(
      'workSummary',
      `Work Summary: ${plan.spec.name}`,
      vscode.ViewColumn.Beside,
      { enableScripts: false }
    );
    
    panel.webview.html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 20px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      line-height: 1.6;
    }
    h1 {
      color: var(--vscode-foreground);
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 12px;
      margin-bottom: 24px;
    }
    .overview-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 16px;
      margin-bottom: 32px;
    }
    .overview-stat {
      background: var(--vscode-sideBar-background);
      padding: 16px;
      border-radius: 8px;
      text-align: center;
    }
    .overview-stat .value {
      font-size: 28px;
      font-weight: bold;
      color: var(--vscode-foreground);
    }
    .overview-stat .label {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
    }
    .overview-stat.added .value { color: #4ec9b0; }
    .overview-stat.modified .value { color: #dcdcaa; }
    .overview-stat.deleted .value { color: #f48771; }
    
    h2 {
      margin-top: 24px;
      margin-bottom: 16px;
      color: var(--vscode-foreground);
    }
    
    .job-card {
      background: var(--vscode-sideBar-background);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
      border-left: 3px solid #4ec9b0;
    }
    .job-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .job-name {
      font-weight: bold;
      font-size: 14px;
    }
    .job-stats {
      font-size: 12px;
    }
    .job-stats span {
      margin-left: 12px;
    }
    .stat-commits { color: var(--vscode-descriptionForeground); }
    .stat-added { color: #4ec9b0; }
    .stat-modified { color: #dcdcaa; }
    .stat-deleted { color: #f48771; }
    
    .job-description {
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
      margin-bottom: 12px;
    }
    
    .commits-list {
      margin-top: 12px;
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
      margin-left: 70px;
      font-size: 11px;
      font-family: var(--vscode-editor-font-family), monospace;
    }
    .file-item {
      padding: 2px 0;
    }
    .file-added { color: #4ec9b0; }
    .file-modified { color: #dcdcaa; }
    .file-deleted { color: #f48771; }
  </style>
</head>
<body>
  <h1>📊 Work Summary: ${this._escapeHtml(plan.spec.name)}</h1>
  
  <div class="overview-grid">
    <div class="overview-stat">
      <div class="value">${summary.totalCommits}</div>
      <div class="label">Total Commits</div>
    </div>
    <div class="overview-stat added">
      <div class="value">+${summary.totalFilesAdded}</div>
      <div class="label">Files Added</div>
    </div>
    <div class="overview-stat modified">
      <div class="value">~${summary.totalFilesModified}</div>
      <div class="label">Files Modified</div>
    </div>
    <div class="overview-stat deleted">
      <div class="value">-${summary.totalFilesDeleted}</div>
      <div class="label">Files Deleted</div>
    </div>
  </div>
  
  ${summary.jobSummaries && summary.jobSummaries.length > 0 ? `
    <h2>Job Details</h2>
    ${jobDetailsHtml}
  ` : ''}
</body>
</html>`;
  }

  private _update() {
    const plan = this._planRunner.get(this._planId);
    if (!plan) {
      this._panel.webview.html = this._getErrorHtml('Plan not found');
      return;
    }
    
    const sm = this._planRunner.getStateMachine(this._planId);
    const status = sm?.computePlanStatus() || 'pending';
    const defaultCounts: Record<NodeStatus, number> = {
      pending: 0, ready: 0, scheduled: 0, running: 0,
      succeeded: 0, failed: 0, blocked: 0, canceled: 0
    };
    const counts = sm?.getStatusCounts() || defaultCounts;
    
    // Create a state hash to detect changes - only re-render if something changed
    const stateHash = JSON.stringify({
      status,
      counts,
      nodeStates: Array.from(plan.nodeStates.entries()).map(([id, s]) => [id, s.status])
    });
    
    if (stateHash === this._lastStateHash) {
      // No change, skip re-render
      return;
    }
    this._lastStateHash = stateHash;
    
    // Compute effective endedAt from node data for accurate duration (recursively includes child plans)
    const effectiveEndedAt = this._planRunner.getEffectiveEndedAt(this._planId) || plan.endedAt;
    
    this._panel.webview.html = this._getHtml(plan, status, counts, effectiveEndedAt);
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
    status: string,
    counts: Record<NodeStatus, number>,
    effectiveEndedAt?: number
  ): string {
    const total = plan.nodes.size;
    const completed = (counts.succeeded || 0) + (counts.failed || 0) + (counts.blocked || 0);
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
    
    // Build Mermaid diagram
    const { diagram: mermaidDef, subgraphData } = this._buildMermaidDiagram(plan);
    
    // Build node data for click handling - recursively include all nested nodes
    const nodeData: Record<string, { nodeId: string; planId: string; type: string; childPlanId?: string; name: string; startedAt?: number; endedAt?: number; status: string }> = {};
    
    // Recursive function to collect all node data with prefixes matching Mermaid IDs
    const collectNodeData = (d: PlanInstance, prefix: string, subgraphCounterStart: number): number => {
      let subgraphCounter = subgraphCounterStart;
      
      for (const [nodeId, node] of d.nodes) {
        const sanitizedId = prefix + this._sanitizeId(nodeId);
        const state = d.nodeStates.get(nodeId);
        
        // For subPlan nodes, get effective endedAt recursively
        let effectiveEndedAt = state?.endedAt;
        if (node.type === 'subPlan' && state?.childPlanId) {
          effectiveEndedAt = this._planRunner.getEffectiveEndedAt(state.childPlanId) || state?.endedAt;
        }
        
        nodeData[sanitizedId] = {
          nodeId,
          planId: d.id,
          type: node.type,
          childPlanId: node.type === 'subPlan' ? (state?.childPlanId || (node as SubPlanNode).childPlanId) : undefined,
          name: node.name,
          startedAt: state?.startedAt,
          endedAt: effectiveEndedAt,
          status: state?.status || 'pending',
        };
        
        // If this is a subPlan with an instantiated child, recurse into it
        if (node.type === 'subPlan') {
          subgraphCounter++;
          const childPlanId = state?.childPlanId || (node as SubPlanNode).childPlanId;
          
          if (childPlanId) {
            const childPlan = this._planRunner.get(childPlanId);
            if (childPlan) {
              subgraphCounter = collectNodeData(childPlan, prefix + 'c' + subgraphCounter + '_', subgraphCounter);
            }
          }
        }
      }
      
      return subgraphCounter;
    };
    
    collectNodeData(plan, '', 0);
    
    // Get branch info
    const baseBranch = plan.spec.baseBranch || 'main';
    const targetBranch = plan.targetBranch || baseBranch;
    const showBranchFlow = baseBranch !== targetBranch || plan.targetBranch;
    
    // Build work summary from node states
    const workSummaryHtml = this._buildWorkSummaryHtml(plan);
    
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://cdn.jsdelivr.net;">
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
    
    /* Duration display in header */
    .header-duration {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      color: var(--vscode-descriptionForeground);
    }
    .duration-icon {
      font-size: 16px;
    }
    .duration-value {
      font-family: var(--vscode-editor-font-family);
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .duration-value.running {
      color: #3794ff;
    }
    .duration-value.succeeded {
      color: #4ec9b0;
    }
    .duration-value.failed {
      color: #f48771;
    }
    
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
      position: relative;
    }
    
    /* Zoom controls */
    .zoom-controls {
      position: sticky;
      top: 0;
      left: 0;
      z-index: 10;
      display: flex;
      gap: 4px;
      margin-bottom: 12px;
      background: rgba(30, 30, 30, 0.95);
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid var(--vscode-widget-border);
      width: fit-content;
    }
    .zoom-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      min-width: 32px;
    }
    .zoom-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .zoom-level {
      display: flex;
      align-items: center;
      padding: 0 8px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      min-width: 50px;
      justify-content: center;
    }
    .mermaid-container {
      transform-origin: top left;
      transition: transform 0.2s ease;
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
    .mermaid .node.branchNode { cursor: default; }  /* Branch nodes are not clickable */
    
    /* Subgraph/cluster styling */
    .mermaid .cluster rect { rx: 8px; ry: 8px; }
    .mermaid .cluster-label,
    .mermaid .cluster-label span,
    .mermaid g.cluster text { 
      cursor: pointer !important;
      font-weight: bold;
      pointer-events: all !important;
    }
    .mermaid .cluster-label:hover,
    .mermaid g.cluster text:hover {
      text-decoration: underline;
      fill: #7DD3FC;
    }
    /* Prevent subgraph title truncation */
    .mermaid .cluster foreignObject {
      overflow: visible !important;
    }
    .mermaid .cluster .nodeLabel {
      white-space: nowrap !important;
      overflow: visible !important;
      text-overflow: unset !important;
    }
    .mermaid svg {
      overflow: visible;
    }
    
    /* Legend */
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      padding: 8px 12px;
      background: rgba(30, 30, 30, 0.9);
      border-radius: 6px;
      border: 1px solid var(--vscode-panel-border);
      align-items: center;
      margin-bottom: 12px;
      font-size: 11px;
    }
    .legend-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
    }
    .legend-icon {
      width: 20px;
      height: 20px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: bold;
    }
    .legend-icon.pending { background: #3c3c3c; border: 1px solid #858585; color: #858585; }
    .legend-icon.running { background: #2d4a6e; border: 1px solid #3794ff; color: #3794ff; }
    .legend-icon.succeeded { background: #1e4d40; border: 1px solid #4ec9b0; color: #4ec9b0; }
    .legend-icon.failed { background: #4d2929; border: 1px solid #f48771; color: #f48771; }
    .legend-icon.blocked { background: #3c3c3c; border: 1px dashed #858585; color: #858585; }
    
    /* Processes Section */
    .processes-section {
      background: var(--vscode-sideBar-background);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
      border-left: 3px solid #3794ff;
    }
    .processes-section h3 {
      margin: 0 0 12px 0;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
    }
    .processes-loading {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: 8px 0;
    }
    .node-processes {
      margin-bottom: 8px;
      background: var(--vscode-editor-background);
      border-radius: 6px;
      overflow: hidden;
    }
    .node-processes.collapsed .node-processes-tree { display: none; }
    .node-processes.collapsed .node-chevron { transform: rotate(-90deg); }
    .node-processes-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      cursor: pointer;
      font-weight: 500;
    }
    .node-processes-header:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .node-chevron {
      font-size: 10px;
      transition: transform 0.2s;
    }
    .node-icon { font-size: 14px; }
    .node-name { flex: 1; }
    .node-stats {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      font-weight: normal;
    }
    .node-name-container {
      display: flex;
      flex-direction: column;
      flex: 1;
      gap: 1px;
    }
    .node-plan-path {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      font-weight: normal;
      opacity: 0.8;
    }
    .node-processes-tree {
      padding: 4px 12px 8px;
      border-top: 1px solid var(--vscode-widget-border);
    }
    .process-item {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 0;
      font-size: 12px;
    }
    .proc-icon { font-size: 12px; }
    .proc-name { flex: 1; font-family: var(--vscode-editor-font-family); }
    .proc-pid { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .proc-stats { color: var(--vscode-descriptionForeground); font-size: 11px; }
    
    /* sub-plan hierarchy styles */
    .subPlan-node {
      margin-bottom: 8px;
      background: var(--vscode-sideBar-background);
      border-radius: 6px;
      overflow: hidden;
      border-left: 3px solid var(--vscode-charts-blue);
    }
    .subPlan-node.collapsed .subPlan-children { display: none; }
    .subPlan-node.collapsed .node-chevron { transform: rotate(-90deg); }
    .subPlan-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      cursor: pointer;
      font-weight: 500;
      background: rgba(0, 100, 200, 0.1);
    }
    .subPlan-header:hover {
      background: rgba(0, 100, 200, 0.15);
    }
    .subPlan-icon { font-size: 14px; }
    .subPlan-name { flex: 1; font-weight: 600; }
    .subPlan-children {
      padding: 8px 8px 8px 12px;
    }
    .subPlan-waiting {
      font-style: italic;
      opacity: 0.7;
    }
    
    /* Job status indicators */
    .job-scheduled .node-stats.job-scheduled {
      color: var(--vscode-charts-yellow);
      font-style: italic;
    }
    .job-running .node-stats.job-starting {
      color: var(--vscode-charts-blue);
      font-style: italic;
    }
    
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
    .action-btn.danger {
      background: #cc3333;
      color: white;
    }
    .action-btn.danger:hover {
      background: #aa2222;
    }
    .action-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  </style>
</head>
<body>
  <div class="header">
    <h2>${this._escapeHtml(plan.spec.name)}</h2>
    <div class="header-duration">
      <span class="duration-icon">⏱</span>
      <span class="duration-value ${status}" id="planDuration" data-started="${plan.startedAt || 0}" data-ended="${effectiveEndedAt || 0}" data-status="${status}">${this._formatPlanDuration(plan.startedAt, effectiveEndedAt)}</span>
    </div>
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
    <div class="zoom-controls">
      <button class="zoom-btn" onclick="zoomOut()" title="Zoom Out">−</button>
      <span class="zoom-level" id="zoomLevel">100%</span>
      <button class="zoom-btn" onclick="zoomIn()" title="Zoom In">+</button>
      <button class="zoom-btn" onclick="zoomReset()" title="Reset Zoom">⟲</button>
      <button class="zoom-btn" onclick="zoomFit()" title="Fit to View">⊡</button>
    </div>
    <div class="legend">
      <div class="legend-item">
        <span class="legend-icon pending">○</span>
        <span>Pending</span>
      </div>
      <div class="legend-item">
        <span class="legend-icon running">▶</span>
        <span>Running</span>
      </div>
      <div class="legend-item">
        <span class="legend-icon succeeded">✓</span>
        <span>Succeeded</span>
      </div>
      <div class="legend-item">
        <span class="legend-icon failed">✗</span>
        <span>Failed</span>
      </div>
      <div class="legend-item">
        <span class="legend-icon blocked">⊘</span>
        <span>Blocked</span>
      </div>
    </div>
    <div class="mermaid-container" id="mermaidContainer">
      <pre class="mermaid">
${mermaidDef}
      </pre>
    </div>
  </div>
  
  ${status === 'running' ? `
  <!-- Running Processes -->
  <div class="processes-section" id="processesSection">
    <h3>Running Processes</h3>
    <div id="processesContainer">
      <div class="processes-loading">Loading processes...</div>
    </div>
  </div>
  ` : ''}
  
  ${workSummaryHtml}
  
  <div class="actions">
    ${status === 'running' || status === 'pending' ? 
      '<button class="action-btn secondary" onclick="cancelPlan()">Cancel</button>' : ''}
    <button class="action-btn secondary" onclick="refresh()">Refresh</button>
    ${status === 'succeeded' ? 
      '<button class="action-btn primary" onclick="showWorkSummary()">View Work Summary</button>' : ''}
    <button class="action-btn danger" onclick="deletePlan()">Delete</button>
  </div>
  
  <script>
    const vscode = acquireVsCodeApi();
    const nodeData = ${JSON.stringify(nodeData)};
    const subgraphData = ${JSON.stringify(subgraphData)};
    const mermaidDef = ${JSON.stringify(mermaidDef)};
    
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      flowchart: {
        useMaxWidth: true,
        htmlLabels: true,
        curve: 'basis',
        padding: 10,
        nodeSpacing: 30,
        rankSpacing: 50
      }
    });
    
    // Render mermaid with error handling
    (async () => {
      try {
        const element = document.querySelector('.mermaid');
        const { svg } = await mermaid.render('mermaid-graph', mermaidDef);
        element.innerHTML = svg;
        // Immediately update durations for running nodes after render
        setTimeout(updateNodeDurations, 100);
      } catch (err) {
        console.error('Mermaid error:', err);
        console.log('Mermaid definition:', mermaidDef);
        const element = document.querySelector('.mermaid');
        element.innerHTML = '<div style="color: #f48771; padding: 16px;"><strong>Mermaid Parse Error:</strong><br><pre style="white-space: pre-wrap; font-size: 11px; margin-top: 8px; background: #2d2d2d; padding: 8px; border-radius: 4px;">' + err.message + '</pre><br><strong>Definition:</strong><pre style="white-space: pre-wrap; font-size: 10px; margin-top: 8px; background: #2d2d2d; padding: 8px; border-radius: 4px; max-height: 200px; overflow: auto;">' + mermaidDef.replace(/</g, '&lt;') + '</pre></div>';
      }
    })();
    
    // Handle node clicks
    document.addEventListener('click', (e) => {
      let el = e.target;
      
      // First check if we clicked on a cluster (subgraph)
      const clickedCluster = el.closest('g.cluster');
      if (clickedCluster && clickedCluster.id) {
        console.log('Cluster clicked, id:', clickedCluster.id);
        // Mermaid uses various formats: "flowchart-sg0-123", "subGraph0", etc.
        const sgMatch = clickedCluster.id.match(/sg(\\d+)/i) || clickedCluster.id.match(/subGraph(\\d+)/i);
        if (sgMatch) {
          const subgraphId = 'sg' + sgMatch[1];
          console.log('Looking for subgraphId:', subgraphId, 'in', Object.keys(subgraphData));
          const data = subgraphData[subgraphId];
          if (data && data.childPlanId) {
            // Only open if we clicked on the label area (top part of cluster), not on nodes inside
            const clickedOnNode = el.closest('.node');
            if (!clickedOnNode || el.closest('.cluster-label')) {
              console.log('Opening sub-plan:', data.childPlanId);
              vscode.postMessage({ type: 'opensubPlan', planId: data.childPlanId });
              e.stopPropagation();
              e.preventDefault();
              return;
            }
          }
        }
      }
      
      while (el && el !== document.body) {
        // Check for node click
        if (el.classList && el.classList.contains('node')) {
          const nodeGroup = el.closest('g[id]');
          if (nodeGroup) {
            const match = nodeGroup.id.match(/flowchart-([^-]+)-/);
            if (match) {
              const sanitizedId = match[1];
              const data = nodeData[sanitizedId];
              if (data) {
                if (data.type === 'subPlan' && data.childPlanId) {
                  vscode.postMessage({ type: 'opensubPlan', planId: data.childPlanId });
                } else {
                  vscode.postMessage({ type: 'openNode', nodeId: data.nodeId, planId: data.planId });
                }
              }
            }
          }
          break;
        }
        el = el.parentElement;
      }
    });
    
    // Make subgraph labels look clickable and add click handlers
    setTimeout(() => {
      document.querySelectorAll('.cluster-label').forEach(label => {
        label.style.cursor = 'pointer';
        label.style.pointerEvents = 'all';
      });
      // Also make the cluster rect clickable
      document.querySelectorAll('g.cluster').forEach(cluster => {
        cluster.style.cursor = 'pointer';
      });
    }, 500);
    
    // Handle job summary clicks
    document.querySelectorAll('.job-summary').forEach(el => {
      el.addEventListener('click', () => {
        const nodeId = el.dataset.nodeId;
        if (nodeId) {
          vscode.postMessage({ type: 'openNode', nodeId });
        }
      });
    });
    
    function cancelPlan() {
      vscode.postMessage({ type: 'cancel' });
    }
    
    function deletePlan() {
      vscode.postMessage({ type: 'delete' });
    }
    
    function refresh() {
      vscode.postMessage({ type: 'refresh' });
    }
    
    function showWorkSummary() {
      vscode.postMessage({ type: 'showWorkSummary' });
    }
    
    // Zoom functionality
    let currentZoom = 1;
    const zoomStep = 0.1;
    const minZoom = 0.25;
    const maxZoom = 3;
    
    function updateZoom() {
      const container = document.getElementById('mermaidContainer');
      const zoomLabel = document.getElementById('zoomLevel');
      if (container) {
        container.style.transform = 'scale(' + currentZoom + ')';
      }
      if (zoomLabel) {
        zoomLabel.textContent = Math.round(currentZoom * 100) + '%';
      }
    }
    
    function zoomIn() {
      currentZoom = Math.min(maxZoom, currentZoom + zoomStep);
      updateZoom();
    }
    
    function zoomOut() {
      currentZoom = Math.max(minZoom, currentZoom - zoomStep);
      updateZoom();
    }
    
    function zoomReset() {
      currentZoom = 1;
      updateZoom();
    }
    
    function zoomFit() {
      const diagram = document.getElementById('mermaid-diagram');
      const container = document.getElementById('mermaidContainer');
      if (!diagram || !container) return;
      
      const svg = container.querySelector('svg');
      if (!svg) return;
      
      // Reset to 1 to measure natural size
      currentZoom = 1;
      container.style.transform = 'scale(1)';
      
      const diagramWidth = diagram.clientWidth - 32; // Account for padding
      const svgWidth = svg.getBoundingClientRect().width;
      
      if (svgWidth > diagramWidth) {
        currentZoom = diagramWidth / svgWidth;
      }
      updateZoom();
    }
    
    // Mouse wheel zoom
    document.getElementById('mermaid-diagram')?.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        if (e.deltaY < 0) {
          zoomIn();
        } else {
          zoomOut();
        }
      }
    });
    
    // Live duration counter
    function formatDurationLive(ms) {
      if (ms < 1000) return '< 1s';
      const secs = Math.floor(ms / 1000);
      if (secs < 60) return secs + 's';
      const mins = Math.floor(secs / 60);
      const remSecs = secs % 60;
      if (mins < 60) return mins + 'm ' + remSecs + 's';
      const hours = Math.floor(mins / 60);
      const remMins = mins % 60;
      return hours + 'h ' + remMins + 'm';
    }
    
    function updateDurationCounter() {
      const el = document.getElementById('planDuration');
      if (!el) return;
      
      const started = parseInt(el.dataset.started) || 0;
      const ended = parseInt(el.dataset.ended) || 0;
      const status = el.dataset.status;
      
      if (!started) {
        el.textContent = '--';
        return;
      }
      
      if (status === 'running' || status === 'pending') {
        const duration = Date.now() - started;
        el.textContent = formatDurationLive(duration);
      } else if (ended) {
        const duration = ended - started;
        el.textContent = formatDurationLive(duration);
      }
    }
    
    // Update duration every second if running
    updateDurationCounter();
    setInterval(updateDurationCounter, 1000);
    
    // Update node durations in SVG for running nodes
    function updateNodeDurations() {
      const svgElement = document.querySelector('.mermaid svg');
      if (!svgElement) return;
      
      // Find all potential text-containing elements in the SVG
      // Mermaid uses foreignObject with various nested elements for htmlLabels
      const allElements = svgElement.querySelectorAll('foreignObject *, text, tspan, .nodeLabel, .label');
      
      for (const [sanitizedId, data] of Object.entries(nodeData)) {
        if (!data.startedAt) continue;
        
        // Only update running/scheduled nodes (not completed ones)
        const isRunning = data.status === 'running' || data.status === 'scheduled';
        if (!isRunning) continue;
        
        const duration = Date.now() - data.startedAt;
        const durationStr = formatDurationLive(duration);
        
        // Find text element containing this node's name and update duration
        for (const textEl of allElements) {
          // Skip elements without direct text content
          if (!textEl.childNodes.length || textEl.children.length > 0) continue;
          
          const text = textEl.textContent || '';
          // Check if this text contains the node name
          if (text.includes(data.name) && text.includes('|')) {
            // Replace the duration part after the pipe
            // Format: "icon NodeName | Xs" or "icon NodeName | Xm Ys"
            const pipeIndex = text.lastIndexOf('|');
            if (pipeIndex > 0) {
              const newText = text.substring(0, pipeIndex + 1) + ' ' + durationStr;
              textEl.textContent = newText;
            }
            break;
          }
        }
      }
    }
    
    // Update node durations every second
    setInterval(updateNodeDurations, 1000);
    
    // Process tree handling for plan-level view
    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'allProcessStats') {
        renderAllProcesses(msg.rootJobs, msg.hierarchy);
      }
    });
    
    function renderAllProcesses(rootJobs, hierarchy) {
      const container = document.getElementById('processesContainer');
      if (!container) return;
      
      const hasRootJobs = rootJobs && rootJobs.length > 0;
      const hassubPlans = hierarchy && hierarchy.length > 0;
      
      if (!hasRootJobs && !hassubPlans) {
        container.innerHTML = '<div class="processes-loading">No active processes</div>';
        return;
      }
      
      let html = '';
      
      // Render root-level jobs first (jobs directly in main Plan)
      for (const job of (rootJobs || [])) {
        html += renderJobNode(job, 0);
      }
      
      // Render sub-plan hierarchy
      for (const subPlan of (hierarchy || [])) {
        html += rendersubPlan(subPlan, 0);
      }
      
      container.innerHTML = html;
    }
    
    // Render a sub-plan as a collapsible section
    function rendersubPlan(subPlan, depth) {
      const indent = depth * 16;
      const hasChildren = (subPlan.children && subPlan.children.length > 0) || (subPlan.jobs && subPlan.jobs.length > 0);
      
      // Count total processes in this sub-plan
      let totalProcs = 0;
      let totalCpu = 0;
      let totalMem = 0;
      
      function sumJobStats(job) {
        const tree = job.tree || [];
        for (const proc of tree) {
          const s = sumProcStats(proc);
          totalProcs += s.count;
          totalCpu += s.cpu;
          totalMem += s.memory;
        }
      }
      
      function sumProcStats(proc) {
        let count = 1;
        let cpu = proc.cpu || 0;
        let memory = proc.memory || 0;
        if (proc.children) {
          for (const child of proc.children) {
            const s = sumProcStats(child);
            count += s.count;
            cpu += s.cpu;
            memory += s.memory;
          }
        }
        return { count, cpu, memory };
      }
      
      for (const job of (subPlan.jobs || [])) {
        sumJobStats(job);
      }
      
      // Recursively sum children
      function sumChildren(children) {
        for (const child of (children || [])) {
          for (const job of (child.jobs || [])) {
            sumJobStats(job);
          }
          sumChildren(child.children);
        }
      }
      sumChildren(subPlan.children);
      
      const memMB = (totalMem / 1024 / 1024).toFixed(1);
      const statusClass = 'subPlan-' + subplan.status;
      
      let html = '<div class="subPlan-node ' + statusClass + '" style="margin-left: ' + indent + 'px;">';
      html += '<div class="subPlan-header" onclick="this.parentElement.classList.toggle(\\'collapsed\\')">';
      html += '<span class="node-chevron">▼</span>';
      html += '<span class="subPlan-icon">📦</span>';
      html += '<span class="subPlan-name">' + escapeHtml(subPlan.planName) + '</span>';
      if (totalProcs > 0) {
        html += '<span class="node-stats">(' + totalProcs + ' proc • ' + totalCpu.toFixed(0) + '% CPU • ' + memMB + ' MB)</span>';
      } else {
        html += '<span class="node-stats subPlan-waiting">(waiting)</span>';
      }
      html += '</div>';
      html += '<div class="subPlan-children">';
      
      // Render jobs in this sub-plan
      for (const job of (subPlan.jobs || [])) {
        html += renderJobNode(job, 1);
      }
      
      // Render nested sub-plans
      for (const child of (subPlan.children || [])) {
        html += rendersubPlan(child, depth + 1);
      }
      
      html += '</div></div>';
      return html;
    }
    
    // Render a job node with its process tree
    function renderJobNode(job, depth) {
      const indent = depth * 16;
      const tree = job.tree || [];
      
      // Calculate totals for this job
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
      const statusClass = 'job-' + job.status;
      const hasProcesses = tree.length > 0;
      
      let html = '<div class="node-processes ' + statusClass + '" style="margin-left: ' + indent + 'px;">';
      html += '<div class="node-processes-header" onclick="this.parentElement.classList.toggle(\\'collapsed\\')">';
      html += '<span class="node-chevron">▼</span>';
      html += '<span class="node-icon">⚡</span>';
      html += '<span class="node-name">' + escapeHtml(job.nodeName) + '</span>';
      
      if (hasProcesses) {
        html += '<span class="node-stats">(' + totals.count + ' proc • ' + totals.cpu.toFixed(0) + '% CPU • ' + memMB + ' MB)</span>';
      } else if (job.status === 'scheduled') {
        html += '<span class="node-stats job-scheduled">(scheduled)</span>';
      } else {
        html += '<span class="node-stats job-starting">(starting...)</span>';
      }
      html += '</div>';
      html += '<div class="node-processes-tree">';
      
      // Render process tree
      for (const proc of tree) {
        html += renderProc(proc, 0);
      }
      
      html += '</div></div>';
      return html;
    }
    
    function renderProc(proc, depth) {
      const memMB = ((proc.memory || 0) / 1024 / 1024).toFixed(1);
      const cpuPct = (proc.cpu || 0).toFixed(0);
      const indent = depth * 16;
      const arrow = depth > 0 ? '↳ ' : '';
      
      let h = '<div class="process-item" style="margin-left: ' + indent + 'px;">';
      h += '<span class="proc-icon">⚙️</span>';
      h += '<span class="proc-name">' + arrow + escapeHtml(proc.name) + '</span>';
      h += '<span class="proc-pid">PID ' + proc.pid + '</span>';
      h += '<span class="proc-stats">' + cpuPct + '% • ' + memMB + ' MB</span>';
      h += '</div>';
      
      if (proc.children) {
        for (const child of proc.children) {
          h += renderProc(child, depth + 1);
        }
      }
      return h;
    }
    
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text || '';
      return div.innerHTML;
    }
    
    // Poll for process stats if running
    const processesSection = document.getElementById('processesSection');
    if (processesSection) {
      vscode.postMessage({ type: 'getAllProcessStats' });
      setInterval(() => {
        vscode.postMessage({ type: 'getAllProcessStats' });
      }, 2000);
    }
  </script>
</body>
</html>`;
  }
  
  /**
   * Build work summary HTML from node execution states
   */
  private _buildWorkSummaryHtml(plan: PlanInstance): string {
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
    
    for (const [nodeId, node] of plan.nodes) {
      if (node.type !== 'job') continue;
      
      const state = plan.nodeStates.get(nodeId);
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
  
  private _buildMermaidDiagram(plan: PlanInstance): { diagram: string; subgraphData: Record<string, { childPlanId: string; name: string }> } {
    const lines: string[] = ['flowchart LR'];
    
    // Track subgraph data for click handling
    const subgraphData: Record<string, { childPlanId: string; name: string }> = {};
    
    // Get branch names
    const baseBranchName = plan.baseBranch || 'main';
    const targetBranchName = plan.targetBranch || baseBranchName;
    const showBaseBranch = baseBranchName !== targetBranchName;
    const showTargetBranch = !!plan.targetBranch;
    
    // Add style definitions
    lines.push('  classDef pending fill:#3c3c3c,stroke:#858585');
    lines.push('  classDef ready fill:#2d4a6e,stroke:#3794ff');
    lines.push('  classDef running fill:#2d4a6e,stroke:#3794ff,stroke-width:2px');
    lines.push('  classDef succeeded fill:#1e4d40,stroke:#4ec9b0');
    lines.push('  classDef failed fill:#4d2929,stroke:#f48771');
    lines.push('  classDef blocked fill:#3c3c3c,stroke:#858585,stroke-dasharray:5');
    lines.push('  classDef branchNode fill:#0e639c,stroke:#0e639c,color:#ffffff');
    lines.push('  classDef baseBranchNode fill:#6e6e6e,stroke:#888888,color:#ffffff');
    lines.push('');
    
    // Track edge indices for linkStyle
    let edgeIndex = 0;
    const successEdges: number[] = [];
    const failedEdges: number[] = [];
    
    // Add base branch node if different from target
    if (showBaseBranch) {
      lines.push(`  BASE_BRANCH["🔀 ${this._escapeForMermaid(baseBranchName)}"]`);
      lines.push('  class BASE_BRANCH baseBranchNode');
    }
    
    // Add source target branch node
    if (showTargetBranch) {
      lines.push(`  TARGET_SOURCE["📍 ${this._escapeForMermaid(targetBranchName)}"]`);
      lines.push('  class TARGET_SOURCE branchNode');
      
      if (showBaseBranch) {
        lines.push('  BASE_BRANCH --> TARGET_SOURCE');
        successEdges.push(edgeIndex++);
      }
    }
    
    lines.push('');
    
    // Track node entry/exit points for edge connections
    const nodeEntryExitMap = new Map<string, { entryIds: string[], exitIds: string[] }>();
    
    // Track leaf node states for mergedToTarget status
    const leafnodeStates = new Map<string, NodeExecutionState | undefined>();
    
    // Counter for unique subgraph IDs
    let subgraphCounter = 0;
    
    // Track all edges to add at the end
    const edgesToAdd: Array<{ from: string; to: string; status?: string }> = [];
    
    // Recursive function to render Plan structure
    const renderPlanInstance = (d: PlanInstance, prefix: string, depth: number): { roots: string[], leaves: string[] } => {
      const indent = '  '.repeat(depth + 1);
      const localRoots: string[] = [];
      const localLeaves: string[] = [];
      
      // First pass: determine which nodes are roots and leaves in this Plan
      const nodeHasDependents = new Set<string>();
      for (const [nodeId, node] of d.nodes) {
        for (const depId of node.dependencies) {
          nodeHasDependents.add(depId);
        }
      }
      
      // Render each node
      for (const [nodeId, node] of d.nodes) {
        const state = d.nodeStates.get(nodeId);
        const status = state?.status || 'pending';
        const sanitizedId = prefix + this._sanitizeId(nodeId);
        
        const isRoot = node.dependencies.length === 0;
        const isLeaf = !nodeHasDependents.has(nodeId);
        
        if (node.type === 'subPlan') {
          const subPlanNode = node as SubPlanNode;
          const label = this._escapeForMermaid(node.name);
          const subgraphId = `sg${subgraphCounter++}`;
          
          // Calculate duration for subPlan - use recursive effective endedAt for child plan
          let durationLabel = '';
          if (state?.startedAt) {
            const childPlanId = state?.childPlanId || subPlanNode.childPlanId;
            // For subPlan nodes, get the effective endedAt recursively from child plan
            const endTime = childPlanId 
              ? (this._planRunner.getEffectiveEndedAt(childPlanId) || state.endedAt || Date.now())
              : (state.endedAt || Date.now());
            const duration = endTime - state.startedAt;
            durationLabel = ' | ' + this._formatNodeDuration(duration);
          }
          
          // Track subgraph data for click handling
          const childPlanId = state?.childPlanId || subPlanNode.childPlanId;
          if (childPlanId) {
            subgraphData[subgraphId] = { childPlanId, name: node.name };
          }
          
          lines.push(`${indent}subgraph ${subgraphId}["${this._getStatusIcon(status)} ${label}${durationLabel}"]`);
          // Don't set direction inside subgraphs - let them inherit from parent
          
          let innerRoots: string[] = [];
          let innerLeaves: string[] = [];
          
          // Try to get instantiated child Plan first
          const childPlan = state?.childPlanId ? this._planRunner.get(state.childPlanId) : undefined;
          
          if (childPlan) {
            // Use instantiated child Plan
            const result = renderPlanInstance(childPlan, prefix + 'c' + subgraphCounter + '_', depth + 1);
            innerRoots = result.roots;
            innerLeaves = result.leaves;
          } else if (subPlanNode.childSpec) {
            // Fall back to spec (child Plan not yet created or already cleaned up)
            const result = renderFromSpec(subPlanNode.childSpec, prefix + 'c' + subgraphCounter + '_', depth + 1, status);
            innerRoots = result.roots;
            innerLeaves = result.leaves;
          }
          
          lines.push(`${indent}end`);
          
          // Style the subgraph based on status
          const boxColor = status === 'running' ? '#1a2a4e' : status === 'succeeded' ? '#1a3a2e' : '#1a1a2e';
          const borderColor = status === 'running' ? '#3794ff' : status === 'succeeded' ? '#4ec9b0' : '#4a4a6a';
          lines.push(`${indent}style ${subgraphId} fill:${boxColor},stroke:${borderColor},stroke-width:2px`);
          
          // Store entry/exit for this subPlan node
          nodeEntryExitMap.set(sanitizedId, {
            entryIds: innerRoots.length > 0 ? innerRoots : [sanitizedId],
            exitIds: innerLeaves.length > 0 ? innerLeaves : [sanitizedId]
          });
          
          // Track roots/leaves
          if (isRoot) localRoots.push(...(innerRoots.length > 0 ? innerRoots : [sanitizedId]));
          if (isLeaf) localLeaves.push(...(innerLeaves.length > 0 ? innerLeaves : [sanitizedId]));
          
          // Add edges from dependencies to this node's entry points
          for (const depId of node.dependencies) {
            const depSanitizedId = prefix + this._sanitizeId(depId);
            edgesToAdd.push({ from: depSanitizedId, to: sanitizedId, status: d.nodeStates.get(depId)?.status });
          }
          
        } else {
          // Regular job node - add status icon and duration to label
          const label = this._escapeForMermaid(node.name);
          const icon = this._getStatusIcon(status);
          
          // Calculate duration for completed or running nodes
          let durationLabel = '';
          if (state?.startedAt) {
            const endTime = state.endedAt || Date.now();
            const duration = endTime - state.startedAt;
            durationLabel = ' | ' + this._formatNodeDuration(duration);
          }
          
          lines.push(`${indent}${sanitizedId}["${icon} ${label}${durationLabel}"]`);
          lines.push(`${indent}class ${sanitizedId} ${status}`);
          
          nodeEntryExitMap.set(sanitizedId, { entryIds: [sanitizedId], exitIds: [sanitizedId] });
          
          if (isRoot) localRoots.push(sanitizedId);
          if (isLeaf) {
            localLeaves.push(sanitizedId);
            // Track state for leaf nodes to check mergedToTarget later
            leafnodeStates.set(sanitizedId, state);
          }
          
          // Add edges from dependencies
          for (const depId of node.dependencies) {
            const depSanitizedId = prefix + this._sanitizeId(depId);
            edgesToAdd.push({ from: depSanitizedId, to: sanitizedId, status: d.nodeStates.get(depId)?.status });
          }
        }
      }
      
      return { roots: localRoots, leaves: localLeaves };
    };
    
    // Render from spec (for sub-plans not yet instantiated)
    const renderFromSpec = (
      spec: import('../../plan/types').PlanSpec, 
      prefix: string, 
      depth: number, 
      inheritedStatus: string
    ): { roots: string[], leaves: string[] } => {
      const indent = '  '.repeat(depth + 1);
      const localRoots: string[] = [];
      const localLeaves: string[] = [];
      
      // Build maps
      const producerToSanitized = new Map<string, string>();
      const nodeHasDependents = new Set<string>();
      
      // First pass: collect all node IDs and build dependency info
      for (const jobSpec of spec.jobs || []) {
        const sanitizedId = prefix + this._sanitizeId(jobSpec.producerId);
        producerToSanitized.set(jobSpec.producerId, sanitizedId);
        for (const dep of jobSpec.dependencies || []) {
          nodeHasDependents.add(dep);
        }
      }
      for (const subPlanSpec of spec.subPlans || []) {
        const sanitizedId = prefix + this._sanitizeId(subPlanSpec.producerId);
        producerToSanitized.set(subPlanSpec.producerId, sanitizedId);
        for (const dep of subPlanSpec.dependencies || []) {
          nodeHasDependents.add(dep);
        }
      }
      
      // Render jobs
      for (const jobSpec of spec.jobs || []) {
        const sanitizedId = producerToSanitized.get(jobSpec.producerId)!;
        const label = this._escapeForMermaid(jobSpec.name || jobSpec.producerId);
        const icon = this._getStatusIcon(inheritedStatus);
        const isRoot = (jobSpec.dependencies || []).length === 0;
        const isLeaf = !nodeHasDependents.has(jobSpec.producerId);
        
        lines.push(`${indent}${sanitizedId}["${icon} ${label}"]`);
        lines.push(`${indent}class ${sanitizedId} ${inheritedStatus}`);
        
        nodeEntryExitMap.set(sanitizedId, { entryIds: [sanitizedId], exitIds: [sanitizedId] });
        
        if (isRoot) localRoots.push(sanitizedId);
        if (isLeaf) localLeaves.push(sanitizedId);
        
        // Add edges
        for (const dep of jobSpec.dependencies || []) {
          const depSanitizedId = producerToSanitized.get(dep);
          if (depSanitizedId) {
            edgesToAdd.push({ from: depSanitizedId, to: sanitizedId });
          }
        }
      }
      
      // Render nested sub-plans
      for (const subPlanSpec of spec.subPlans || []) {
        const sanitizedId = producerToSanitized.get(subPlanSpec.producerId)!;
        const label = this._escapeForMermaid(subPlanSpec.name || subPlanSpec.producerId);
        const subgraphId = `sg${subgraphCounter++}`;
        const isRoot = (subPlanSpec.dependencies || []).length === 0;
        const isLeaf = !nodeHasDependents.has(subPlanSpec.producerId);
        
        lines.push(`${indent}subgraph ${subgraphId}["${this._getStatusIcon(inheritedStatus)} ${label}"]`);
        // Don't set direction inside subgraphs - let them inherit from parent
        
        // Build nested spec and render
        const nestedSpec: import('../../plan/types').PlanSpec = {
          name: subPlanSpec.name || subPlanSpec.producerId,
          jobs: subPlanSpec.jobs,
          subPlans: subPlanSpec.subPlans,
        };
        
        const result = renderFromSpec(nestedSpec, prefix + 'n' + subgraphCounter + '_', depth + 1, inheritedStatus);
        
        lines.push(`${indent}end`);
        lines.push(`${indent}style ${subgraphId} fill:#1a1a2e,stroke:#4a4a6a,stroke-width:2px`);
        
        nodeEntryExitMap.set(sanitizedId, {
          entryIds: result.roots.length > 0 ? result.roots : [sanitizedId],
          exitIds: result.leaves.length > 0 ? result.leaves : [sanitizedId]
        });
        
        if (isRoot) localRoots.push(...(result.roots.length > 0 ? result.roots : [sanitizedId]));
        if (isLeaf) localLeaves.push(...(result.leaves.length > 0 ? result.leaves : [sanitizedId]));
        
        // Add edges
        for (const dep of subPlanSpec.dependencies || []) {
          const depSanitizedId = producerToSanitized.get(dep);
          if (depSanitizedId) {
            edgesToAdd.push({ from: depSanitizedId, to: sanitizedId });
          }
        }
      }
      
      return { roots: localRoots, leaves: localLeaves };
    };
    
    // Render the main Plan
    const mainResult = renderPlanInstance(plan, '', 0);
    
    lines.push('');
    
    // Add edges from target branch to root nodes
    if (showTargetBranch) {
      for (const rootId of mainResult.roots) {
        const mapping = nodeEntryExitMap.get(rootId);
        const entryIds = mapping ? mapping.entryIds : [rootId];
        for (const entryId of entryIds) {
          lines.push(`  TARGET_SOURCE --> ${entryId}`);
          successEdges.push(edgeIndex++);
        }
      }
    }
    
    // Add all collected edges
    for (const edge of edgesToAdd) {
      const fromMapping = nodeEntryExitMap.get(edge.from);
      const toMapping = nodeEntryExitMap.get(edge.to);
      
      const fromExits = fromMapping ? fromMapping.exitIds : [edge.from];
      const toEntries = toMapping ? toMapping.entryIds : [edge.to];
      
      for (const exit of fromExits) {
        for (const entry of toEntries) {
          lines.push(`  ${exit} --> ${entry}`);
          if (edge.status === 'succeeded') {
            successEdges.push(edgeIndex);
          } else if (edge.status === 'failed') {
            failedEdges.push(edgeIndex);
          }
          edgeIndex++;
        }
      }
    }
    
    // Add edges to target branch from leaf nodes
    if (showTargetBranch) {
      lines.push('');
      lines.push(`  TARGET_DEST["🎯 ${this._escapeForMermaid(targetBranchName)}"]`);
      lines.push('  class TARGET_DEST branchNode');
      
      for (const leafId of mainResult.leaves) {
        const mapping = nodeEntryExitMap.get(leafId);
        const exitIds = mapping ? mapping.exitIds : [leafId];
        for (const exitId of exitIds) {
          // Check if this leaf has been successfully merged to target
          const leafState = leafnodeStates.get(exitId);
          const isMerged = leafState?.mergedToTarget === true;
          
          if (isMerged) {
            // Use solid line and mark as success edge
            lines.push(`  ${exitId} --> TARGET_DEST`);
            successEdges.push(edgeIndex);
          } else {
            // Use dotted line for pending merge
            lines.push(`  ${exitId} -.-> TARGET_DEST`);
          }
          edgeIndex++;
        }
      }
    }
    
    // Add linkStyle for colored edges
    if (successEdges.length > 0) {
      lines.push(`  linkStyle ${successEdges.join(',')} stroke:#4ec9b0,stroke-width:2px`);
    }
    if (failedEdges.length > 0) {
      lines.push(`  linkStyle ${failedEdges.join(',')} stroke:#f48771,stroke-width:2px`);
    }
    
    return { diagram: lines.join('\n'), subgraphData };
  }
  
  private _getStatusIcon(status: string): string {
    switch (status) {
      case 'succeeded': return '✓';
      case 'failed': return '✗';
      case 'running': return '▶';
      case 'blocked': return '⊘';
      default: return '○';
    }
  }
  
  private _sanitizeId(id: string): string {
    return 'node_' + id.replace(/[^a-zA-Z0-9]/g, '_');
  }
  
  private _escapeForMermaid(str: string): string {
    return str
      .replace(/"/g, "'")
      .replace(/[<>{}|:#]/g, '')
      .replace(/\[/g, '(')
      .replace(/\]/g, ')');
  }
  
  private _formatPlanDuration(startedAt?: number, endedAt?: number): string {
    if (!startedAt) return '--';
    const duration = (endedAt || Date.now()) - startedAt;
    if (duration < 1000) return '< 1s';
    const secs = Math.floor(duration / 1000);
    if (secs < 60) return secs + 's';
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    if (mins < 60) return mins + 'm ' + remSecs + 's';
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    return hours + 'h ' + remMins + 'm';
  }
  
  private _formatNodeDuration(ms: number): string {
    if (ms < 1000) return '< 1s';
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return secs + 's';
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    if (mins < 60) return mins + 'm ' + remSecs + 's';
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    return hours + 'h ' + remMins + 'm';
  }
  
  private _escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
