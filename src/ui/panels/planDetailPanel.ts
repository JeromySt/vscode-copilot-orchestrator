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
import { PlanRunner, PlanInstance, PlanNode, JobNode, NodeStatus, NodeExecutionState } from '../../plan';
import { escapeHtml, formatDurationMs, errorPageHtml, commitDetailsHtml, workSummaryStatsHtml } from '../templates';

/**
 * Webview panel that shows a detailed view of a single Plan's execution.
 *
 * Displays a Mermaid-based DAG diagram of the Plan's node structure, real-time
 * node status updates, progress tracking, branch/merge flow, work summary
 * (commit/file stats), and action buttons (cancel, delete).
 *
 * Only one panel is created per Plan ID — subsequent calls to
 * {@link createOrShow} reveal the existing panel.
 *
 * **Webview → Extension messages:**
 * - `{ type: 'cancel' }` — cancel the Plan
 * - `{ type: 'delete' }` — delete the Plan
 * - `{ type: 'openNode', nodeId: string, planId?: string }` — open a {@link NodeDetailPanel}
 * - `{ type: 'openNode', nodeId, planId }` — open a node detail panel
 * - `{ type: 'refresh' }` — request a manual data refresh
 * - `{ type: 'showWorkSummary' }` — open work summary in a separate webview panel
 * - `{ type: 'getAllProcessStats' }` — request process tree statistics
 *
 * **Extension → Webview messages:**
 * - Full HTML re-render via `webview.html` on each update cycle
 * - `{ type: 'allProcessStats', flat, hierarchy, rootJobs }` — process stats response
 *
 * @see {@link NodeDetailPanel} for per-node detail views
 */
export class planDetailPanel {
  private static panels = new Map<string, planDetailPanel>();
  
  private readonly _panel: vscode.WebviewPanel;
  private _planId: string;
  private _disposables: vscode.Disposable[] = [];
  private _updateInterval?: NodeJS.Timeout;
  private _lastStateVersion: number = -1;
  private _lastStructureHash: string = '';
  private _isFirstRender: boolean = true;
  
  /**
   * @param panel - The VS Code webview panel instance.
   * @param planId - Unique identifier of the Plan to display.
   * @param _planRunner - The {@link PlanRunner} instance for querying Plan/node state.
   */
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
  
  /**
   * Create a new detail panel for the given Plan, or reveal an existing one.
   *
   * If a panel for `planId` already exists, it is brought to the foreground.
   * Otherwise a new {@link vscode.WebviewPanel} is created in
   * {@link vscode.ViewColumn.One} with scripts enabled and context retention.
   *
   * @param extensionUri - The extension's root URI (used for local resource roots).
   * @param planId - The unique identifier of the Plan to display.
   * @param planRunner - The {@link PlanRunner} instance for querying state.
   */
  public static createOrShow(
    extensionUri: vscode.Uri,
    planId: string,
    planRunner: PlanRunner,
    options?: { preserveFocus?: boolean }
  ) {
    const preserveFocus = options?.preserveFocus ?? false;
    
    // Check if panel already exists
    const existing = planDetailPanel.panels.get(planId);
    if (existing) {
      existing._panel.reveal(undefined, preserveFocus);
      return;
    }
    
    const plan = planRunner.get(planId);
    const title = plan ? `Plan: ${plan.spec.name}` : `Plan: ${planId.slice(0, 8)}`;
    
    // Create new panel - createWebviewPanel always takes focus, so we need to restore
    // focus back to tree if preserveFocus is requested
    const panel = vscode.window.createWebviewPanel(
      'planDetail',
      title,
      { viewColumn: vscode.ViewColumn.One, preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );
    
    const planPanel = new planDetailPanel(panel, planId, planRunner);
    planDetailPanel.panels.set(planId, planPanel);
  }
  
  /**
   * Close all panels associated with a Plan (used when Plan is deleted).
   *
   * @param planId - The Plan ID whose panel should be closed.
   */
  public static closeForPlan(planId: string): void {
    const panel = planDetailPanel.panels.get(planId);
    if (panel) {
      panel.dispose();
    }
  }
  
  /** Dispose the panel, clear timers, and remove it from the static panel map. */
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
  
  /**
   * Handle incoming messages from the webview.
   *
   * @param message - The message object received from the webview's `postMessage`.
   */
  private _handleMessage(message: any) {
    switch (message.type) {
      case 'cancel':
        vscode.commands.executeCommand('orchestrator.cancelPlan', this._planId);
        break;
      case 'pause':
        vscode.commands.executeCommand('orchestrator.pausePlan', this._planId).then(() => {
          // Force refresh after pause to update button visibility
          setTimeout(() => this._forceFullRefresh(), 100);
        });
        break;
      case 'resume':
        vscode.commands.executeCommand('orchestrator.resumePlan', this._planId).then(() => {
          // Force refresh after resume to update button visibility
          setTimeout(() => this._forceFullRefresh(), 100);
        });
        break;
      case 'delete':
        vscode.commands.executeCommand('orchestrator.deletePlan', this._planId);
        break;
      case 'openNode':
        // Use the planId from the message if provided (for nodes in child Plans), otherwise use the main Plan ID
        const planIdForNode = message.planId || this._planId;
        vscode.commands.executeCommand('orchestrator.showNodeDetails', planIdForNode, message.nodeId);
        break;

      case 'refresh':
        this._forceFullRefresh();
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
  
  /**
   * Query all process stats for this Plan and send them to the webview.
   */
  private async _sendAllProcessStats() {
    try {
      const stats = await this._planRunner.getAllProcessStats(this._planId);
      this._panel.webview.postMessage({
        type: 'allProcessStats',
        flat: (stats as any).flat || [],
        hierarchy: (stats as any).hierarchy || [],
        rootJobs: (stats as any).rootJobs || []
      });
    } catch (err) {
      // Send empty stats on error to clear the loading state
      this._panel.webview.postMessage({
        type: 'allProcessStats',
        flat: [],
        hierarchy: [],
        rootJobs: []
      });
    }
  }
  
  /**
   * Open the Plan's work summary in a separate read-only webview panel
   * (displayed beside the current editor column).
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
        const commitsHtml = commitDetailsHtml(job.commitDetails || []);
        
        jobDetailsHtml += `
          <div class="job-card">
            <div class="job-header">
              <span class="job-name">${escapeHtml(job.nodeName)}</span>
              <span class="job-stats">
                <span class="stat-commits">${job.commits} commits</span>
                <span class="stat-added">+${job.filesAdded}</span>
                <span class="stat-modified">~${job.filesModified}</span>
                <span class="stat-deleted">-${job.filesDeleted}</span>
              </span>
            </div>
            <div class="job-description">${escapeHtml(job.description)}</div>
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
  <h1>📊 Work Summary: ${escapeHtml(plan.spec.name)}</h1>
  
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

  /**
   * Force a full HTML re-render, bypassing the state hash check.
   * Used when the webview requests a refresh (e.g., after an error).
   */
  private _forceFullRefresh() {
    const plan = this._planRunner.get(this._planId);
    if (!plan) {
      this._panel.webview.html = this._getErrorHtml('Plan not found');
      return;
    }
    
    const sm = this._planRunner.getStateMachine(this._planId);
    const status = sm?.computePlanStatus() || 'pending';
    const recursiveCounts = this._planRunner.getRecursiveStatusCounts(this._planId);
    const effectiveEndedAt = this._planRunner.getEffectiveEndedAt(this._planId) || plan.endedAt;
    
    // Reset hashes to force next _update to also do full render
    this._lastStateVersion = -1;
    this._lastStructureHash = '';
    this._isFirstRender = true;
    
    this._panel.webview.html = this._getHtml(plan, status, recursiveCounts.counts, effectiveEndedAt, recursiveCounts.totalNodes);
  }

  /**
   * Re-render the panel HTML if the Plan state has changed since the last render.
   * Uses a JSON state hash to skip redundant re-renders.
   */
  private _update() {
    const plan = this._planRunner.get(this._planId);
    if (!plan) {
      this._panel.webview.html = this._getErrorHtml('Plan not found');
      return;
    }
    
    const sm = this._planRunner.getStateMachine(this._planId);
    const status = sm?.computePlanStatus() || 'pending';
    
    // Get recursive counts including all child plans (for accurate totals)
    const recursiveCounts = this._planRunner.getRecursiveStatusCounts(this._planId);
    const counts = recursiveCounts.counts;
    const totalNodes = recursiveCounts.totalNodes;
    
    // Build node status map for incremental updates (includes version for efficient updates)
    const nodeStatuses: Record<string, { status: string; version: number; startedAt?: number; endedAt?: number }> = {};
    for (const [nodeId, state] of plan.nodeStates) {
      const sanitizedId = this._sanitizeId(nodeId);
      nodeStatuses[sanitizedId] = {
        status: state.status,
        version: state.version || 0,
        startedAt: state.startedAt,
        endedAt: state.endedAt
      };
    }
    
    // Add group statuses (groups use same sanitized ID pattern as nodes)
    for (const [groupId, state] of plan.groupStates) {
      const sanitizedId = this._sanitizeId(groupId);
      nodeStatuses[sanitizedId] = {
        status: state.status,
        version: state.version || 0,
        startedAt: state.startedAt,
        endedAt: state.endedAt
      };
    }
    
    // Structure hash: nodes and their dependencies (doesn't change during execution)
    const structureHash = JSON.stringify({
      nodes: Array.from(plan.nodes.entries()).map(([id, n]) => [id, n.name, (n as JobNode).dependencies]),
      spec: plan.spec.name
    });
    
    // Use stateVersion for efficient change detection (incremented on every state change)
    const currentStateVersion = plan.stateVersion || 0;
    
    // If nothing changed, skip entirely
    if (currentStateVersion === this._lastStateVersion) {
      return;
    }
    
    const structureChanged = structureHash !== this._lastStructureHash;
    this._lastStateVersion = currentStateVersion;
    this._lastStructureHash = structureHash;
    
    // If structure changed or first render, do full HTML render
    if (structureChanged || this._isFirstRender) {
      this._isFirstRender = false;
      // Compute effective endedAt from node data for accurate duration
      const effectiveEndedAt = this._planRunner.getEffectiveEndedAt(this._planId) || plan.endedAt;
      this._panel.webview.html = this._getHtml(plan, status, counts, effectiveEndedAt, totalNodes);
      return;
    }
    
    // Otherwise, send incremental status update (preserves zoom/scroll)
    const total = totalNodes ?? plan.nodes.size;
    const completed = (counts.succeeded || 0) + (counts.failed || 0) + (counts.blocked || 0) + (counts.canceled || 0);
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
    const effectiveEndedAt = this._planRunner.getEffectiveEndedAt(this._planId) || plan.endedAt;
    
    this._panel.webview.postMessage({
      type: 'statusUpdate',
      planStatus: status,
      stateVersion: currentStateVersion,
      nodeStatuses,
      counts,
      progress,
      total,
      completed,
      startedAt: plan.startedAt,
      endedAt: effectiveEndedAt
    });
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
   * Build the full HTML document for the Plan detail view.
   *
   * Includes a Mermaid DAG diagram, node status grid, progress bar, action buttons,
   * branch flow info, and work summary section. Loads Mermaid from CDN.
   *
   * @param plan - The Plan instance to render.
   * @param status - The computed overall Plan status.
   * @param counts - Per-{@link NodeStatus} counts from the state machine.
   * @param effectiveEndedAt - Optional override for the Plan's end timestamp
   *   (accounts for still-running child Plans).
   * @param totalNodes - Total node count recursively including child plans.
   * @returns Full HTML document string.
   */
  private _getHtml(
    plan: PlanInstance,
    status: string,
    counts: Record<NodeStatus, number>,
    effectiveEndedAt?: number,
    totalNodes?: number
  ): string {
    const total = totalNodes ?? plan.nodes.size;
    const completed = (counts.succeeded || 0) + (counts.failed || 0) + (counts.blocked || 0) + (counts.canceled || 0);
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
    
    // Build Mermaid diagram
    const { diagram: mermaidDef, nodeTooltips } = this._buildMermaidDiagram(plan);
    
    // Build node data for click handling
    const nodeData: Record<string, { nodeId: string; planId: string; type: string; name: string; startedAt?: number; endedAt?: number; status: string; version: number }> = {};
    
    // Collect all node data with prefixes matching Mermaid IDs
    for (const [nodeId, node] of plan.nodes) {
      const sanitizedId = this._sanitizeId(nodeId);
      const state = plan.nodeStates.get(nodeId);
      
      nodeData[sanitizedId] = {
        nodeId,
        planId: plan.id,
        type: node.type,
        name: node.name,
        startedAt: state?.startedAt,
        endedAt: state?.endedAt,
        status: state?.status || 'pending',
        version: state?.version || 0,
      };
    }
    
    // Add group data for duration tracking
    for (const [groupId, state] of plan.groupStates) {
      const sanitizedId = this._sanitizeId(groupId);
      const group = plan.groups.get(groupId);
      nodeData[sanitizedId] = {
        nodeId: groupId,
        planId: plan.id,
        type: 'group',
        name: group?.name || groupId,
        startedAt: state?.startedAt,
        endedAt: state?.endedAt,
        status: state?.status || 'pending',
        version: state?.version || 0,
      };
    }
    
    // Get branch info
    const baseBranch = plan.spec.baseBranch || 'main';
    const targetBranch = plan.targetBranch || baseBranch;
    const showBranchFlow = baseBranch !== targetBranch || plan.targetBranch;
    
    // Build work summary from node states
    const workSummaryHtml = this._buildWorkSummaryHtml(plan);
    const tokenSummaryHtml = this._buildTokenSummaryHtml(plan);
    
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
    .status-badge.paused { background: rgba(255, 165, 0, 0.2); color: #ffa500; }
    .status-badge.canceled { background: rgba(133, 133, 133, 0.2); color: #858585; }
    
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
    #mermaid-diagram {
      cursor: grab;
    }
    #mermaid-diagram.panning {
      cursor: grabbing;
      user-select: none;
    }
    #mermaid-diagram.panning .mermaid-container {
      transition: none;
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
    .mermaid .node.branchNode,
    .mermaid .node.baseBranchNode,
    .mermaid g[id*="BASE_BRANCH"] .node,
    .mermaid g[id*="TARGET_SOURCE"] .node,
    .mermaid g[id*="TARGET_MERGED"] .node { cursor: default; }  /* Branch nodes are not clickable */
    
    /* Node labels are pre-truncated server-side; let Mermaid size the box */
    .mermaid .node .nodeLabel {
      white-space: nowrap !important;
    }
    
    /* Subgraph/cluster styling */
    .mermaid .cluster rect { 
      rx: 8px; 
      ry: 8px;
    }
    .mermaid .cluster,
    .mermaid .cluster-label,
    .mermaid g.cluster,
    .mermaid g.cluster foreignObject,
    .mermaid g.cluster foreignObject div {
      overflow: visible !important;
      clip-path: none !important;
    }
    .mermaid .cluster-label,
    .mermaid .cluster-label span,
    .mermaid g.cluster text { 
      cursor: pointer !important;
      font-weight: bold;
      pointer-events: all !important;
    }
    /* Disable any clipping on cluster labels */
    .mermaid .cluster .label-container {
      overflow: visible !important;
    }
    .mermaid .cluster-label:hover,
    .mermaid g.cluster text:hover {
      text-decoration: underline;
      fill: #7DD3FC;
    }
    /* Subgraph titles are pre-truncated server-side; let Mermaid size the box */
    .mermaid .cluster .nodeLabel {
      white-space: nowrap !important;
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
    
    /* Process Aggregation Summary */
    .processes-summary {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 10px 14px;
      margin-bottom: 12px;
      background: rgba(55, 148, 255, 0.08);
      border: 1px solid rgba(55, 148, 255, 0.25);
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
    }
    .processes-summary-label {
      color: var(--vscode-foreground);
    }
    .processes-summary-stat {
      color: var(--vscode-descriptionForeground);
      font-weight: 500;
      font-size: 12px;
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
    
    .token-summary {
      background: var(--vscode-sideBar-background);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
    }
    .token-summary > summary {
      margin: 0 0 12px 0;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font-weight: 600;
    }
    .token-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .token-table th,
    .token-table td {
      padding: 6px 10px;
      text-align: right;
      border-bottom: 1px solid var(--vscode-widget-border);
    }
    .token-table th:first-child,
    .token-table td:first-child {
      text-align: left;
    }
    .token-table th {
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .token-table .total-row td {
      font-weight: 600;
      border-top: 2px solid var(--vscode-widget-border);
      border-bottom: none;
    }
    
    .actions {
      margin-top: 16px;
      display: flex;
      gap: 8px;
    }
    .action-btn {
      padding: 6px 12px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      transition: background 0.15s, opacity 0.15s;
    }
    .action-btn:hover {
      opacity: 0.9;
    }
    .action-btn.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .action-btn.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--vscode-button-secondaryBackground);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.1);
    }
    .action-btn.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground));
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
    <h2>${escapeHtml(plan.spec.name)}</h2>
    <div class="header-duration">
      <span class="duration-icon">⏱</span>
      <span class="duration-value ${status}" id="planDuration" data-started="${plan.startedAt || 0}" data-ended="${effectiveEndedAt || 0}" data-status="${status}">${this._formatPlanDuration(plan.startedAt, effectiveEndedAt)}</span>
    </div>
    <span class="status-badge ${status}">${status}</span>
  </div>
  
  ${showBranchFlow ? `
  <div class="branch-flow">
    <span class="branch-label">Base:</span>
    <span class="branch-name">${escapeHtml(baseBranch)}</span>
    <span class="branch-arrow">→</span>
    <span class="branch-label">Work</span>
    <span class="branch-arrow">→</span>
    <span class="branch-label">Target:</span>
    <span class="branch-name">${escapeHtml(targetBranch)}</span>
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
  
  ${tokenSummaryHtml}
  
  <div class="actions">
    ${status === 'running' || status === 'pending' ? 
      '<button id="pauseBtn" class="action-btn secondary" onclick="pausePlan()">Pause</button>' : 
      '<button id="pauseBtn" class="action-btn secondary" onclick="pausePlan()" style="display:none">Pause</button>'}
    ${status === 'paused' ? 
      '<button id="resumeBtn" class="action-btn primary" onclick="resumePlan()">Resume</button>' : 
      '<button id="resumeBtn" class="action-btn primary" onclick="resumePlan()" style="display:none">Resume</button>'}
    ${status === 'running' || status === 'pending' || status === 'paused' ? 
      '<button id="cancelBtn" class="action-btn secondary" onclick="cancelPlan()">Cancel</button>' : 
      '<button id="cancelBtn" class="action-btn secondary" onclick="cancelPlan()" style="display:none">Cancel</button>'}
    <button class="action-btn secondary" onclick="refresh()">Refresh</button>
    ${status === 'succeeded' ? 
      '<button id="workSummaryBtn" class="action-btn primary" onclick="showWorkSummary()">View Work Summary</button>' : 
      '<button id="workSummaryBtn" class="action-btn primary" onclick="showWorkSummary()" style="display:none">View Work Summary</button>'}
    <button class="action-btn danger" onclick="deletePlan()">Delete</button>
  </div>
  
  <script>
    const vscode = acquireVsCodeApi();
    const nodeData = ${JSON.stringify(nodeData)};
    const nodeTooltips = ${JSON.stringify(nodeTooltips)};
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
        
        // Fix cluster label clipping: expand foreignObject width to fit text
        const clusterLabels = element.querySelectorAll('.cluster-label');
        clusterLabels.forEach(label => {
          // Find the foreignObject (parent) and expand its width
          let parent = label.parentElement;
          while (parent && parent.tagName !== 'foreignObject') {
            parent = parent.parentElement;
          }
          if (parent && parent.tagName === 'foreignObject') {
            // Get actual text width and add padding
            const textEl = label.querySelector('.nodeLabel, span, div');
            if (textEl) {
              const textWidth = textEl.scrollWidth || textEl.offsetWidth || 200;
              const currentWidth = parseFloat(parent.getAttribute('width')) || 0;
              if (textWidth + 20 > currentWidth) {
                parent.setAttribute('width', String(textWidth + 30));
              }
            }
          }
          // Also set overflow visible on the label itself
          label.style.overflow = 'visible';
          label.style.width = 'auto';
        });
        
        // Add tooltips for truncated node labels
        for (const [id, fullName] of Object.entries(nodeTooltips)) {
          // Regular nodes: Mermaid renders them as g[id*="id"]
          const nodeEl = element.querySelector('g[id*="' + id + '"]');
          if (nodeEl) {
            const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
            titleEl.textContent = fullName;
            nodeEl.prepend(titleEl);
          }
          // Subgraph clusters
          const clusterEl = element.querySelector('g[id*="' + id + '"] .cluster-label');
          if (clusterEl) {
            const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
            titleEl.textContent = fullName;
            clusterEl.prepend(titleEl);
          }
        }
        // Immediately update durations for running nodes after render
        setTimeout(updateNodeDurations, 100);
        // Set initial container size based on rendered SVG
        setTimeout(updateZoom, 150);
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
                vscode.postMessage({ type: 'openNode', nodeId: data.nodeId, planId: data.planId });
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
    
    function cancelPlan() {
      vscode.postMessage({ type: 'cancel' });
    }
    
    function pausePlan() {
      vscode.postMessage({ type: 'pause' });
    }
    
    function resumePlan() {
      vscode.postMessage({ type: 'resume' });
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
        
        // Adjust container size to match scaled content (prevents empty space when zoomed out)
        const svg = container.querySelector('svg');
        if (svg) {
          const naturalWidth = svg.getBBox().width + 20;
          const naturalHeight = svg.getBBox().height + 20;
          container.style.width = (naturalWidth * currentZoom) + 'px';
          container.style.height = (naturalHeight * currentZoom) + 'px';
        }
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
    
    // Mouse wheel zoom (no modifier needed when over diagram)
    const diagramEl = document.getElementById('mermaid-diagram');
    diagramEl?.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.deltaY < 0) {
        zoomIn();
      } else {
        zoomOut();
      }
    }, { passive: false });
    
    // Mouse drag to pan
    let isPanning = false;
    let didPan = false;
    let panStartX = 0;
    let panStartY = 0;
    let scrollStartX = 0;
    let scrollStartY = 0;
    
    diagramEl?.addEventListener('mousedown', (e) => {
      // Only pan on left mouse button, and not on interactive elements
      if (e.button !== 0) return;
      const target = e.target;
      if (target.closest('.zoom-controls, .legend, button, a')) return;
      
      isPanning = true;
      didPan = false;
      panStartX = e.clientX;
      panStartY = e.clientY;
      scrollStartX = diagramEl.scrollLeft;
      scrollStartY = diagramEl.scrollTop;
      diagramEl.classList.add('panning');
      e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
      if (!isPanning || !diagramEl) return;
      
      const dx = e.clientX - panStartX;
      const dy = e.clientY - panStartY;
      
      // Mark as panned if moved more than 5px (distinguish from click)
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        didPan = true;
      }
      
      diagramEl.scrollLeft = scrollStartX - dx;
      diagramEl.scrollTop = scrollStartY - dy;
    });
    
    document.addEventListener('mouseup', () => {
      if (isPanning && diagramEl) {
        isPanning = false;
        diagramEl.classList.remove('panning');
      }
    });
    
    // Suppress click after pan
    document.addEventListener('click', (e) => {
      if (didPan) {
        e.stopPropagation();
        e.preventDefault();
        didPan = false;
      }
    }, true); // Use capture phase to intercept before other handlers
    
    // Also stop panning if mouse leaves the window
    document.addEventListener('mouseleave', () => {
      if (isPanning && diagramEl) {
        isPanning = false;
        diagramEl.classList.remove('panning');
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
      
      for (const [sanitizedId, data] of Object.entries(nodeData)) {
        if (!data.startedAt) continue;
        
        // Only update running/scheduled nodes/groups (not completed ones)
        const isRunning = data.status === 'running' || data.status === 'scheduled';
        if (!isRunning) continue;
        
        const duration = Date.now() - data.startedAt;
        const durationStr = formatDurationLive(duration);
        
        // Find the element - either a node or a cluster (group)
        let targetGroup = svgElement.querySelector('g[id*="' + sanitizedId + '"]');
        let textEls;
        
        // Check if this is a cluster/subgraph
        if (data.type === 'group') {
          // Try cluster selectors
          let cluster = svgElement.querySelector('g.cluster[id*="' + sanitizedId + '"], g[id*="' + sanitizedId + '"].cluster');
          if (!cluster) {
            const allClusters = svgElement.querySelectorAll('g.cluster');
            for (const c of allClusters) {
              const clusterId = c.getAttribute('id') || '';
              if (clusterId.includes(sanitizedId)) {
                cluster = c;
                break;
              }
            }
          }
          if (cluster) {
            targetGroup = cluster;
            textEls = cluster.querySelectorAll('.cluster-label .nodeLabel, .cluster-label text, .nodeLabel, text');
          }
        } else {
          // Regular node
          if (targetGroup) {
            textEls = targetGroup.querySelectorAll('foreignObject *, text, tspan, .nodeLabel, .label');
          }
        }
        
        if (!targetGroup || !textEls) continue;
        
        for (const textEl of textEls) {
          if (!textEl.childNodes.length || textEl.children.length > 0) continue;
          
          const text = textEl.textContent || '';
          if (text.includes('|')) {
            // Update existing duration
            const pipeIndex = text.lastIndexOf('|');
            if (pipeIndex > 0) {
              const newText = text.substring(0, pipeIndex + 1) + ' ' + durationStr;
              textEl.textContent = newText;
            }
            break;
          } else if (text.length > 0) {
            // No duration yet - add it (node just started running)
            textEl.textContent = text + ' | ' + durationStr;
            break;
          }
        }
      }
    }
    
    // Update node durations every second
    setInterval(updateNodeDurations, 1000);
    
    // Handle messages from extension (incremental updates, process stats)
    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'allProcessStats') {
        renderAllProcesses(msg.rootJobs);
      } else if (msg.type === 'statusUpdate') {
        handleStatusUpdate(msg);
      }
    });
    
    // Handle incremental status updates without full re-render (preserves zoom/scroll)
    function handleStatusUpdate(msg) {
      try {
        const { planStatus, nodeStatuses, counts, progress, total, completed, startedAt, endedAt } = msg;
        
        // Update plan status badge
        const statusBadge = document.querySelector('.status-badge');
        if (statusBadge) {
          statusBadge.className = 'status-badge ' + planStatus;
          statusBadge.textContent = planStatus.charAt(0).toUpperCase() + planStatus.slice(1);
        }
        
        // Update progress bar
        const progressFill = document.querySelector('.progress-fill');
        const progressText = document.querySelector('.progress-text');
        if (progressFill) {
          progressFill.style.width = progress + '%';
        }
        if (progressText) {
          progressText.textContent = completed + ' / ' + total + ' (' + progress + '%)';
        }
        
        // Update stats section
        const statsContainer = document.querySelector('.stats');
        if (statsContainer) {
          const statItems = statsContainer.querySelectorAll('.stat');
          statItems.forEach(stat => {
            const label = stat.querySelector('.stat-label');
            const value = stat.querySelector('.stat-value');
            if (!label || !value) return;
            const labelText = label.textContent.trim();
            if (labelText === 'Total Nodes') {
              value.textContent = total;
            } else if (labelText === 'Succeeded') {
              value.textContent = counts.succeeded || 0;
            } else if (labelText === 'Failed') {
              value.textContent = counts.failed || 0;
            } else if (labelText === 'Running') {
              value.textContent = (counts.running || 0) + (counts.scheduled || 0);
            } else if (labelText === 'Pending') {
              value.textContent = (counts.pending || 0) + (counts.ready || 0);
            }
          });
        }
        
        // Update legend counts
        const legendItems = document.querySelectorAll('.legend-item');
        legendItems.forEach(item => {
          const icon = item.querySelector('.legend-icon');
          if (!icon) return;
          const statusClass = Array.from(icon.classList).find(c => c !== 'legend-icon');
          if (statusClass && counts[statusClass] !== undefined) {
            const span = item.querySelector('span:last-child');
            if (span) {
              span.textContent = statusClass.charAt(0).toUpperCase() + statusClass.slice(1) + ' (' + counts[statusClass] + ')';
            }
          }
        });
        
        // Status color map (must match classDef in buildMermaidDiagram)
        const statusColors = {
          pending: { fill: '#3c3c3c', stroke: '#858585' },
          ready: { fill: '#2d4a6e', stroke: '#3794ff' },
          running: { fill: '#2d4a6e', stroke: '#3794ff' },
          scheduled: { fill: '#2d4a6e', stroke: '#3794ff' },
          succeeded: { fill: '#1e4d40', stroke: '#4ec9b0' },
          failed: { fill: '#4d2929', stroke: '#f48771' },
          blocked: { fill: '#3c3c3c', stroke: '#858585' },
          canceled: { fill: '#3c3c3c', stroke: '#858585' }
        };
        
        // Update Mermaid node colors in SVG directly (Mermaid uses inline styles)
        const svgElement = document.querySelector('.mermaid svg');
        let nodesUpdated = 0;
        const totalNodes = Object.keys(nodeStatuses).length;
        
        if (!svgElement) {
          console.warn('SVG element not found in handleStatusUpdate');
        }
        
        if (svgElement) {
          for (const [sanitizedId, data] of Object.entries(nodeStatuses)) {
            // Skip if version hasn't changed (efficient update)
            const existingData = nodeData[sanitizedId];
            if (existingData && existingData.version === data.version) {
              nodesUpdated++; // Count as success (already up to date)
              continue;
            }
            
            // Status colors for groups/subgraphs (dimmer than nodes)
            const groupColors = {
              pending: { fill: '#1a1a2e', stroke: '#6a6a8a' },
              ready: { fill: '#1a2a4e', stroke: '#3794ff' },
              running: { fill: '#1a2a4e', stroke: '#3794ff' },
              succeeded: { fill: '#1a3a2e', stroke: '#4ec9b0' },
              failed: { fill: '#3a1a1e', stroke: '#f48771' },
              blocked: { fill: '#3a1a1e', stroke: '#f48771' },
              canceled: { fill: '#1a1a2e', stroke: '#6a6a8a' },
            };
            
            // Try to find as a node first
            // Mermaid generates IDs like "flowchart-nabc123...-0" where nabc123... is our sanitizedId
            const nodeGroup = svgElement.querySelector('g[id^="flowchart-' + sanitizedId + '-"]');
            
            if (nodeGroup) {
              nodesUpdated++;
              const nodeEl = nodeGroup.querySelector('.node') || nodeGroup;
              
              // Update CSS class for additional styling
              nodeEl.classList.remove('pending', 'ready', 'running', 'succeeded', 'failed', 'blocked', 'canceled', 'scheduled');
              nodeEl.classList.add(data.status);
              
              // Update inline styles on the rect (Mermaid uses inline styles from classDef)
              const rect = nodeEl.querySelector('rect');
              if (rect && statusColors[data.status]) {
                rect.style.fill = statusColors[data.status].fill;
                rect.style.stroke = statusColors[data.status].stroke;
                // Add animation for running nodes
                if (data.status === 'running') {
                  rect.style.strokeWidth = '2px';
                } else {
                  rect.style.strokeWidth = '';
                }
              }
              
              // Update icon in node label
              const foreignObject = nodeEl.querySelector('foreignObject');
              const textSpan = foreignObject ? foreignObject.querySelector('span') : nodeEl.querySelector('text tspan, text');
              if (textSpan) {
                const icons = { succeeded: '✓', failed: '✗', running: '▶', blocked: '⊘', pending: '○', ready: '○', scheduled: '▶', canceled: '⊘' };
                const newIcon = icons[data.status] || '○';
                const currentText = textSpan.textContent || '';
                // Replace first character (icon) with new icon
                if (currentText.length > 0 && ['✓', '✗', '▶', '⊘', '○'].includes(currentText[0])) {
                  textSpan.textContent = newIcon + currentText.substring(1);
                }
              }
            } else {
              // Try to find as a subgraph (group)
              // Mermaid generates subgraph clusters with ID patterns we can match
              let cluster = svgElement.querySelector('g.cluster[id*="' + sanitizedId + '"], g[id*="' + sanitizedId + '"].cluster');
              
              // Fallback: iterate all clusters and check their IDs
              if (!cluster) {
                const allClusters = svgElement.querySelectorAll('g.cluster');
                for (const c of allClusters) {
                  const clusterId = c.getAttribute('id') || '';
                  if (clusterId.includes(sanitizedId)) {
                    cluster = c;
                    break;
                  }
                }
              }
              
              // Update the cluster if found
              if (cluster) {
                const clusterRect = cluster.querySelector('rect');
                if (clusterRect && groupColors[data.status]) {
                  clusterRect.style.fill = groupColors[data.status].fill;
                  clusterRect.style.stroke = groupColors[data.status].stroke;
                }
                // Update icon in subgraph label - Mermaid uses various label selectors
                const labelText = cluster.querySelector('.cluster-label .nodeLabel, .cluster-label text, .nodeLabel, text');
                if (labelText) {
                  const icons = { succeeded: '✓', failed: '✗', running: '▶', blocked: '⊘', pending: '○', ready: '○', scheduled: '▶', canceled: '⊘' };
                  const newIcon = icons[data.status] || '○';
                  const currentText = labelText.textContent || '';
                  // Check for status icon at start or package icon (📦)
                  if (currentText.length > 0) {
                    const firstChar = currentText[0];
                    if (['✓', '✗', '▶', '⊘', '○', '📦'].includes(firstChar)) {
                      labelText.textContent = newIcon + currentText.substring(1);
                    }
                  }
                }
                nodesUpdated++;
              }
            }
            
            // Update nodeData for duration tracking (and version for next comparison)
            if (nodeData[sanitizedId]) {
              nodeData[sanitizedId].status = data.status;
              nodeData[sanitizedId].version = data.version;
              nodeData[sanitizedId].startedAt = data.startedAt;
              nodeData[sanitizedId].endedAt = data.endedAt;
            }
          }
        }
        
        // If we couldn't update any nodes and there are nodes to update, force full refresh
        if (totalNodes > 0 && nodesUpdated === 0) {
          console.warn('SVG node update failed: updated 0 of ' + totalNodes + ' nodes, requesting full refresh');
          vscode.postMessage({ type: 'refresh' });
          return;
        }
        
        // Update plan duration counter data attributes
        const durationEl = document.getElementById('planDuration');
        if (durationEl) {
          durationEl.dataset.status = planStatus;
          if (startedAt) durationEl.dataset.started = startedAt.toString();
          if (endedAt) durationEl.dataset.ended = endedAt.toString();
        }
        
        // Update action buttons visibility based on new status
        const actionsDiv = document.querySelector('.actions');
        if (actionsDiv) {
          const pauseBtn = document.getElementById('pauseBtn');
          const resumeBtn = document.getElementById('resumeBtn');
          const cancelBtn = document.getElementById('cancelBtn');
          const workSummaryBtn = document.getElementById('workSummaryBtn');
          
          const isActive = (planStatus === 'running' || planStatus === 'pending');
          const isPaused = (planStatus === 'paused');
          const canControl = isActive || isPaused;
          
          if (pauseBtn) {
            pauseBtn.style.display = isActive ? '' : 'none';
          }
          if (resumeBtn) {
            resumeBtn.style.display = isPaused ? '' : 'none';
          }
          if (cancelBtn) {
            cancelBtn.style.display = canControl ? '' : 'none';
          }
          if (workSummaryBtn) {
            workSummaryBtn.style.display = planStatus === 'succeeded' ? '' : 'none';
          }
        }
        
        // Trigger duration update
        updateNodeDurations();
      } catch (err) {
        console.error('handleStatusUpdate error:', err);
        // On error, request a full refresh
        vscode.postMessage({ type: 'refresh' });
      }
    }
    
    function formatMemory(bytes) {
      const mb = bytes / 1024 / 1024;
      if (mb >= 1024) {
        return (mb / 1024).toFixed(2) + ' GB';
      }
      return mb.toFixed(1) + ' MB';
    }

    function sumAllProcessStats(rootJobs) {
      let totalCount = 0;
      let totalCpu = 0;
      let totalMemory = 0;

      function sumProc(proc) {
        totalCount++;
        totalCpu += proc.cpu || 0;
        totalMemory += proc.memory || 0;
        if (proc.children) {
          for (const child of proc.children) {
            sumProc(child);
          }
        }
      }

      function sumJob(job) {
        for (const proc of (job.tree || [])) {
          sumProc(proc);
        }
      }

      for (const job of (rootJobs || [])) {
        sumJob(job);
      }

      return { totalCount, totalCpu, totalMemory };
    }

    function renderAllProcesses(rootJobs) {
      const container = document.getElementById('processesContainer');
      if (!container) return;
      
      const hasRootJobs = rootJobs && rootJobs.length > 0;
      
      if (!hasRootJobs) {
        container.innerHTML = '<div class="processes-loading">No active processes</div>';
        return;
      }
      
      // Aggregation summary
      const agg = sumAllProcessStats(rootJobs);
      let html = '<div class="processes-summary">';
      html += '<span class="processes-summary-label">Total</span>';
      html += '<span class="processes-summary-stat">' + agg.totalCount + ' processes</span>';
      html += '<span class="processes-summary-stat">' + agg.totalCpu.toFixed(0) + '% CPU</span>';
      html += '<span class="processes-summary-stat">' + formatMemory(agg.totalMemory) + '</span>';
      html += '</div>';
      
      // Render all jobs
      for (const job of (rootJobs || [])) {
        html += renderJobNode(job, 0);
      }
      
      container.innerHTML = html;
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
   * Build work summary HTML from node execution states.
   *
   * Aggregates commit/file counts across all nodes that have a work summary,
   * then renders stats cards and per-job detail sections.
   *
   * @param plan - The Plan instance whose node states contain work summaries.
   * @returns HTML fragment string, or empty string if no work has been performed.
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
        <span class="job-name">${escapeHtml(j.name)}</span>
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
  
  /**
   * Build an HTML token usage summary table from node metrics.
   *
   * Iterates over all job nodes that have token usage metrics and produces
   * a collapsible `<details>` element with per-job rows and a totals footer.
   *
   * @param plan - The Plan instance to summarise token usage for.
   * @returns HTML string (empty if no token usage data is available).
   */
  private _buildTokenSummaryHtml(plan: PlanInstance): string {
    const jobRows: Array<{
      name: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cost: number;
    }> = [];

    for (const [nodeId, node] of plan.nodes) {
      if (node.type !== 'job') continue;

      const state = plan.nodeStates.get(nodeId);
      if (!state?.metrics?.tokenUsage) continue;

      const tu = state.metrics.tokenUsage;
      jobRows.push({
        name: node.name,
        model: tu.model || 'N/A',
        inputTokens: tu.inputTokens || 0,
        outputTokens: tu.outputTokens || 0,
        totalTokens: tu.totalTokens || 0,
        cost: tu.estimatedCostUsd || 0,
      });
    }

    if (jobRows.length === 0) {
      return '';
    }

    const totalInput = jobRows.reduce((s, j) => s + j.inputTokens, 0);
    const totalOutput = jobRows.reduce((s, j) => s + j.outputTokens, 0);
    const totalTokens = jobRows.reduce((s, j) => s + j.totalTokens, 0);
    const totalCost = jobRows.reduce((s, j) => s + j.cost, 0);

    const rowsHtml = jobRows.map(j => `
      <tr>
        <td>${escapeHtml(j.name)}</td>
        <td>${escapeHtml(j.model)}</td>
        <td>${j.inputTokens.toLocaleString()}</td>
        <td>${j.outputTokens.toLocaleString()}</td>
        <td>${j.totalTokens.toLocaleString()}</td>
        <td>${j.cost > 0 ? '$' + j.cost.toFixed(4) : 'N/A'}</td>
      </tr>
    `).join('');

    return `
    <details class="token-summary" open>
      <summary>Token Usage Summary</summary>
      <table class="token-table">
        <thead>
          <tr>
            <th>Job</th>
            <th>Model</th>
            <th>Input</th>
            <th>Output</th>
            <th>Total</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
        <tfoot>
          <tr class="total-row">
            <td colspan="2">Total</td>
            <td>${totalInput.toLocaleString()}</td>
            <td>${totalOutput.toLocaleString()}</td>
            <td>${totalTokens.toLocaleString()}</td>
            <td>${totalCost > 0 ? '$' + totalCost.toFixed(4) : 'N/A'}</td>
          </tr>
        </tfoot>
      </table>
    </details>
    `;
  }
  
  /**
   * Build a Mermaid flowchart definition for the Plan's node DAG.
   *
   * Recursively expands sub-plan nodes into subgraphs. Applies status-based
   * styling (green for succeeded, red for failed, blue for running) and tracks
   * edge indices for `linkStyle` coloring.
   *
   * @param plan - The Plan instance whose nodes form the DAG.
   * @returns An object containing the Mermaid diagram string and node tooltips.
   */
  private _buildMermaidDiagram(plan: PlanInstance): { diagram: string; nodeTooltips: Record<string, string> } {
    const lines: string[] = ['flowchart LR'];
    
    // Track full names for tooltip display when labels are truncated
    const nodeTooltips: Record<string, string> = {};
    
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
    
    // Counter for unique group subgraph IDs
    let groupSubgraphCounter = 0;
    
    // Track all edges to add at the end
    const edgesToAdd: Array<{ from: string; to: string; status?: string }> = [];
    
    // Helper function to render a single job node
    const renderJobNode = (
      node: JobNode,
      nodeId: string,
      d: PlanInstance,
      prefix: string,
      indent: string,
      nodeHasDependents: Set<string>,
      localRoots: string[],
      localLeaves: string[]
    ) => {
      const state = d.nodeStates.get(nodeId);
      const status = state?.status || 'pending';
      const sanitizedId = prefix + this._sanitizeId(nodeId);
      
      const isRoot = node.dependencies.length === 0;
      const isLeaf = !nodeHasDependents.has(nodeId);
      
      const label = this._escapeForMermaid(node.name);
      const icon = this._getStatusIcon(status);
      
      // Calculate duration for completed or running nodes
      // Always include a duration placeholder to maintain consistent node sizing
      let durationLabel = ' | --';
      if (state?.startedAt) {
        const endTime = state.endedAt || Date.now();
        const duration = endTime - state.startedAt;
        durationLabel = ' | ' + formatDurationMs(duration);
      }
      
      // Nodes are not truncated — they size their own Mermaid boxes.
      const displayLabel = label;
      
      // Add trailing non-breaking spaces to prevent Mermaid SVG text clipping
      // Use 4 spaces to account for status icon width + duration label characters
      const nbsp = '\u00A0';
      const nodePadding = nbsp.repeat(4);
      lines.push(`${indent}${sanitizedId}["${icon} ${displayLabel}${durationLabel}${nodePadding}"]`);
      lines.push(`${indent}class ${sanitizedId} ${status}`);
      
      nodeEntryExitMap.set(sanitizedId, { entryIds: [sanitizedId], exitIds: [sanitizedId] });
      
      if (isRoot) localRoots.push(sanitizedId);
      if (isLeaf) {
        localLeaves.push(sanitizedId);
        leafnodeStates.set(sanitizedId, state);
      }
      
      // Add edges from dependencies
      for (const depId of node.dependencies) {
        const depSanitizedId = prefix + this._sanitizeId(depId);
        edgesToAdd.push({ from: depSanitizedId, to: sanitizedId, status: d.nodeStates.get(depId)?.status });
      }
    };
    
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
      
      // Organize nodes by group tag
      const groupedNodes = new Map<string, { nodeId: string; node: PlanNode }[]>();
      const ungroupedNodes: { nodeId: string; node: PlanNode }[] = [];
      
      for (const [nodeId, node] of d.nodes) {
        const groupTag = node.group;
        if (groupTag) {
          if (!groupedNodes.has(groupTag)) {
            groupedNodes.set(groupTag, []);
          }
          groupedNodes.get(groupTag)!.push({ nodeId, node });
        } else {
          ungroupedNodes.push({ nodeId, node });
        }
      }
      
      // Build a tree structure from group paths
      interface GroupTreeNode {
        name: string;
        children: Map<string, GroupTreeNode>;
        nodes: { nodeId: string; node: PlanNode }[];
      }
      
      const groupTree: GroupTreeNode = { name: '', children: new Map(), nodes: [] };
      
      for (const [groupPath, nodes] of groupedNodes) {
        const parts = groupPath.split('/');
        let current = groupTree;
        
        for (const part of parts) {
          if (!current.children.has(part)) {
            current.children.set(part, { name: part, children: new Map(), nodes: [] });
          }
          current = current.children.get(part)!;
        }
        
        // Nodes belong to the leaf group
        current.nodes = nodes;
      }
      
      // Pre-compute rendered label width for each node (icon + name + duration)
      // so that group labels can be truncated to the widest descendant node.
      const nodeLabelWidths = new Map<string, number>();
      for (const [nodeId, node] of d.nodes) {
        const escapedName = this._escapeForMermaid(node.name);
        const st = d.nodeStates.get(nodeId);
        let dur = ' | --';
        if (st?.startedAt) {
          const endTime = st.endedAt || Date.now();
          dur = ' | ' + formatDurationMs(endTime - st.startedAt);
        }
        // Total = icon(2) + name + duration (matches the formula in _truncateLabel)
        nodeLabelWidths.set(nodeId, 2 + escapedName.length + dur.length);
      }

      // Recursively compute the max descendant-node label width for each group
      const computeMaxGroupWidth = (treeNode: GroupTreeNode): number => {
        let maxW = 0;
        for (const { nodeId } of treeNode.nodes) {
          const w = nodeLabelWidths.get(nodeId) || 0;
          if (w > maxW) maxW = w;
        }
        for (const child of treeNode.children.values()) {
          const w = computeMaxGroupWidth(child);
          if (w > maxW) maxW = w;
        }
        return maxW;
      };

      const groupMaxWidths = new Map<string, number>();
      const precomputeGroupWidths = (treeNode: GroupTreeNode, path: string) => {
        groupMaxWidths.set(path, computeMaxGroupWidth(treeNode));
        for (const [childName, child] of treeNode.children) {
          const childPath = path ? `${path}/${childName}` : childName;
          precomputeGroupWidths(child, childPath);
        }
      };
      for (const [name, child] of groupTree.children) {
        precomputeGroupWidths(child, name);
      }

      // Recursively render group tree as nested subgraphs
      const renderGroupTree = (
        treeNode: GroupTreeNode,
        groupPath: string,
        currentIndent: string
      ): void => {
        // Look up the group UUID from the path
        const groupUuid = d.groupPathToId.get(groupPath);
        const groupState = groupUuid ? d.groupStates.get(groupUuid) : undefined;
        const groupStatus = groupState?.status || 'pending';
        
        // Use sanitized group UUID as the subgraph ID (same pattern as nodes)
        const sanitizedGroupId = groupUuid ? this._sanitizeId(groupUuid) : `grp${groupSubgraphCounter++}`;
        
        // Get icon for group status (same as nodes)
        const icon = this._getStatusIcon(groupStatus);
        
        // Calculate duration for groups
        // Always include a duration placeholder to maintain consistent sizing
        let groupDurationLabel = ' | --';
        if (groupState?.startedAt) {
          const endTime = groupState.endedAt || Date.now();
          const duration = endTime - groupState.startedAt;
          groupDurationLabel = ' | ' + formatDurationMs(duration);
        }
        
        // Status-specific styling for groups (same colors as nodes)
        const groupColors: Record<string, { fill: string; stroke: string }> = {
          pending: { fill: '#1a1a2e', stroke: '#6a6a8a' },
          ready: { fill: '#1a2a4e', stroke: '#3794ff' },
          running: { fill: '#1a2a4e', stroke: '#3794ff' },
          succeeded: { fill: '#1a3a2e', stroke: '#4ec9b0' },
          failed: { fill: '#3a1a1e', stroke: '#f48771' },
          blocked: { fill: '#3a1a1e', stroke: '#f48771' },
          canceled: { fill: '#1a1a2e', stroke: '#6a6a8a' },
        };
        const colors = groupColors[groupStatus] || groupColors.pending;
        
        // Truncate group names based on the widest descendant node's rendered
        // label width, so the group title never overflows its content box.
        const displayName = groupPath || treeNode.name;
        const escapedName = this._escapeForMermaid(displayName);
        const maxWidth = groupMaxWidths.get(groupPath) || 0;
        const truncatedGroupName = maxWidth > 0
          ? this._truncateLabel(escapedName, groupDurationLabel, maxWidth)
          : escapedName;
        if (truncatedGroupName !== escapedName) {
          nodeTooltips[sanitizedGroupId] = displayName;
        }
        const nbsp = '\u00A0'; // non-breaking space
        const padding = nbsp.repeat(4); // extra padding to prevent cutoff
        
        lines.push(`${currentIndent}subgraph ${sanitizedGroupId}["${icon} ${truncatedGroupName}${groupDurationLabel}${padding}"]`);
        
        const childIndent = currentIndent + '  ';
        
        // Render child groups first (nested subgraphs)
        for (const childGroup of treeNode.children.values()) {
          const childPath = groupPath ? `${groupPath}/${childGroup.name}` : childGroup.name;
          renderGroupTree(childGroup, childPath, childIndent);
        }
        
        // Render nodes directly in this group
        for (const { nodeId, node } of treeNode.nodes) {
          renderJobNode(node as JobNode, nodeId, d, prefix, childIndent, nodeHasDependents, localRoots, localLeaves);
        }
        
        lines.push(`${currentIndent}end`);
        lines.push(`${currentIndent}style ${sanitizedGroupId} fill:${colors.fill},stroke:${colors.stroke},stroke-width:2px,stroke-dasharray:5`);
      };
      
      // Render ungrouped nodes first
      for (const { nodeId, node } of ungroupedNodes) {
        renderJobNode(node as JobNode, nodeId, d, prefix, indent, nodeHasDependents, localRoots, localLeaves);
      }
      
      // Render group tree (top-level groups)
      for (const topGroup of groupTree.children.values()) {
        renderGroupTree(topGroup, topGroup.name, indent);
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
    
    return { diagram: lines.join('\n'), nodeTooltips };
  }
  
  /**
   * Map a node status string to a single-character icon.
   *
   * @param status - The node status (e.g., `'succeeded'`, `'failed'`, `'running'`).
   * @returns A Unicode status icon character.
   */
  private _getStatusIcon(status: string): string {
    switch (status) {
      case 'succeeded': return '✓';
      case 'failed': return '✗';
      case 'running': return '▶';
      case 'blocked': return '⊘';
      default: return '○';
    }
  }
  
  /**
   * Convert a node ID (UUID) to a Mermaid-safe identifier.
   * Simply prefixes with 'n' and strips hyphens from UUID.
   * 
   * @param id - The raw node ID (UUID like "abc12345-6789-...").
   * @returns Mermaid-safe ID like "nabc123456789..."
   */
  private _sanitizeId(id: string): string {
    // UUIDs have hyphens; just remove them and prefix with 'n'
    return 'n' + id.replace(/-/g, '');
  }
  
  /**
   * Escape a string for safe inclusion in a Mermaid node label.
   *
   * @param str - The raw label text.
   * @returns The escaped string with Mermaid-special characters removed or replaced.
   */
  private _escapeForMermaid(str: string): string {
    return str
      .replace(/"/g, "'")
      .replace(/[<>{}|:#]/g, '')
      .replace(/\[/g, '(')
      .replace(/\]/g, ')');
  }

  /**
   * Truncate a label name so that the combined label (icon + name + duration)
   * stays within the given `maxLen` characters. When truncation occurs the
   * name is trimmed and an ellipsis ('...') is appended.
   *
   * @param name - The escaped display name.
   * @param durationLabel - The duration suffix (e.g., ' | 2m 34s'), may be empty.
   * @param maxLen - Maximum total character count (icon(2) + name + duration).
   * @returns The (possibly truncated) name.
   */
  private _truncateLabel(name: string, durationLabel: string, maxLen: number): string {
    // +2 accounts for the status icon + space prefix ("✓ ")
    const totalLen = 2 + name.length + durationLabel.length;
    if (totalLen <= maxLen) {
      return name;
    }
    // Reserve space for icon, duration, and ellipsis
    const available = maxLen - 2 - durationLabel.length - 3; // 3 = '...'
    if (available <= 0) {
      return name; // duration alone exceeds limit – don't truncate name to nothing
    }
    return name.slice(0, available).trimEnd() + '...';
  }
  
  /**
   * Format a Plan's duration from start/end timestamps.
   *
   * @param startedAt - Epoch millisecond timestamp when the Plan started.
   * @param endedAt - Epoch millisecond timestamp when the Plan ended (uses `Date.now()` if omitted).
   * @returns Human-readable duration string, or `'--'` if `startedAt` is not set.
   */
  private _formatPlanDuration(startedAt?: number, endedAt?: number): string {
    if (!startedAt) return '--';
    const duration = (endedAt || Date.now()) - startedAt;
    return formatDurationMs(duration);
  }
}
