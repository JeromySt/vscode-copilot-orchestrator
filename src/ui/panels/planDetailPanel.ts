/**
 * @fileoverview Plan Detail Panel - shows plan execution flow.
 * 
 * Displays a visual representation of the plan with:
 * - Dependency graph showing job relationships
 * - Merge branches for multi-parent dependencies
 * - Real-time status updates
 * - Clickable jobs to view their details
 * 
 * @module ui/panels/planDetailPanel
 */

import * as vscode from 'vscode';
import { Plan, PlanJob, SubPlanSpec } from '../plansViewProvider';
import { 
  getPlanDetailCss, 
  getPlanDetailLoadingCss, 
  getWorkSummaryCss,
  getPlanDetailJs,
  getWorkSummaryJs 
} from '../templates/planDetail';

/**
 * Callback to get merge branches for a plan
 */
export type GetMergeBranchesCallback = (planId: string) => Map<string, string> | undefined;


/**
 * Manages plan detail webview panels
 */
export class PlanDetailPanel {
  /** Map of plan ID to panel instance - supports multiple open panels */
  private static panels = new Map<string, PlanDetailPanel>();
  
  /** @deprecated Use panels map instead. Kept for backward compatibility. */
  public static get currentPanel(): PlanDetailPanel | undefined {
    // Return the most recently accessed panel for backward compat
    const values = [...PlanDetailPanel.panels.values()];
    return values.length > 0 ? values[values.length - 1] : undefined;
  }
  
  private readonly _panel: vscode.WebviewPanel;
  private _planId: string;
  private _plan: Plan | undefined;
  private _disposables: vscode.Disposable[] = [];
  private _updateInterval?: NodeJS.Timeout;
  private _getPlan: (id: string) => Plan | undefined;
  private _getMergeBranches?: GetMergeBranchesCallback;
  
  private constructor(
    panel: vscode.WebviewPanel,
    planId: string,
    getPlan: (id: string) => Plan | undefined,
    getMergeBranches?: GetMergeBranchesCallback
  ) {
    this._panel = panel;
    this._planId = planId;
    this._getPlan = getPlan;
    this._getMergeBranches = getMergeBranches;
    
    // Show loading state immediately
    this._panel.webview.html = this._getLoadingHtml();
    
    // Defer content loading to allow loading state to render
    setImmediate(() => this._update());
    
    // Start update interval for running plans
    this._updateInterval = setInterval(() => this._update(), 2000);
    
    // Handle messages
    this._panel.webview.onDidReceiveMessage(
      message => this._handleMessage(message),
      null,
      this._disposables
    );
    
    // Handle panel disposal
    this._panel.onDidDispose(
      () => this.dispose(),
      null,
      this._disposables
    );
  }
  
  public static createOrShow(
    extensionUri: vscode.Uri,
    planId: string,
    getPlan: (id: string) => Plan | undefined,
    getMergeBranches?: GetMergeBranchesCallback
  ) {
    const column = vscode.ViewColumn.Active;  // Open in current tab group
    
    // Check if we already have a panel for this specific plan
    const existingPanel = PlanDetailPanel.panels.get(planId);
    if (existingPanel) {
      existingPanel._getPlan = getPlan;
      existingPanel._getMergeBranches = getMergeBranches;
      existingPanel._panel.reveal(column);
      // Show loading state while refreshing
      existingPanel._panel.webview.html = existingPanel._getLoadingHtml();
      // Defer content loading to allow loading state to render
      setImmediate(() => existingPanel._update());
      return existingPanel;
    }
    
    // Create new panel for this plan
    const panel = vscode.window.createWebviewPanel(
      'planDetail',
      'Loading Plan...',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );
    
    const newPanel = new PlanDetailPanel(panel, planId, getPlan, getMergeBranches);
    PlanDetailPanel.panels.set(planId, newPanel);
    return newPanel;
  }
  
  public dispose() {
    // Remove from panels map
    PlanDetailPanel.panels.delete(this._planId);
    
    if (this._updateInterval) {
      clearInterval(this._updateInterval);
    }
    
    this._panel.dispose();
    
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
    }
  }
  
  private async _handleMessage(message: any) {
    switch (message.type) {
      case 'openJob':
        vscode.commands.executeCommand('orchestrator.showJobDetails', message.jobId);
        break;
      case 'openNestedPlan':
        // Open nested plan in a new panel
        vscode.commands.executeCommand('orchestrator.showPlanDetails', message.planId);
        break;
      case 'cancelPlan':
        vscode.commands.executeCommand('orchestrator.cancelPlan', this._planId);
        setTimeout(() => this._update(), 500);
        break;
      case 'retryPlan':
        vscode.commands.executeCommand('orchestrator.retryPlan', this._planId);
        setTimeout(() => this._update(), 500);
        break;
      case 'deletePlan':
        // Wait for the delete command to complete (includes user confirmation)
        await vscode.commands.executeCommand('orchestrator.deletePlan', this._planId);
        // Check if plan was actually deleted (user may have cancelled)
        const planStillExists = this._getPlan(this._planId);
        if (!planStillExists) {
          // Plan was deleted, close the panel
          this.dispose();
        } else {
          // User cancelled or deletion failed, reset the button
          this._panel.webview.postMessage({ type: 'deleteReset' });
        }
        break;
      case 'showWorkSummary':
        this._showWorkSummaryPanel();
        break;
      case 'refresh':
        this._update();
        break;
    }
  }
  
  /**
   * Show a detailed work summary panel for the plan.
   * Rich UI matching Job Details style with expandable commit details.
   */
  private _showWorkSummaryPanel() {
    const plan = this._getPlan(this._planId);
    if (!plan || !plan.aggregatedWorkSummary) {
      vscode.window.showInformationMessage('No work summary available for this plan yet.');
      return;
    }
    
    const ws = plan.aggregatedWorkSummary;
    const htmlContent = this._buildWorkSummaryHtml(plan, ws);
    
    // Show in a new webview tab
    const panel = vscode.window.createWebviewPanel(
      'planWorkSummary',
      `Work Summary: ${plan.name}`,
      vscode.ViewColumn.Active,  // Open in current tab group
      { enableScripts: true }
    );
    
    panel.webview.html = htmlContent;
  }
  
  /**
   * Build rich Work Summary HTML matching Job Details UX.
   */
  private _buildWorkSummaryHtml(plan: Plan, ws: NonNullable<Plan['aggregatedWorkSummary']>): string {
    // Build job sections with expandable commit details
    const jobSectionsHtml = ws.jobSummaries.map((job, jobIndex) => {
      const hasCommits = job.commitDetails && job.commitDetails.length > 0;
      const chevron = hasCommits ? '<span class="job-chevron">▶</span>' : '';
      
      // Build commit details
      let commitDetailsHtml = '';
      if (hasCommits && job.commitDetails) {
        const commitsHtml = job.commitDetails.map(commit => {
          const filesHtml = [
            ...commit.filesAdded.map(f => `<div class="commit-file file-added"><span class="file-status">+</span> ${this._escapeHtml(f)}</div>`),
            ...commit.filesModified.map(f => `<div class="commit-file file-modified"><span class="file-status">~</span> ${this._escapeHtml(f)}</div>`),
            ...commit.filesDeleted.map(f => `<div class="commit-file file-deleted"><span class="file-status">−</span> ${this._escapeHtml(f)}</div>`)
          ].join('');
          
          const commitDate = new Date(commit.date).toLocaleString();
          
          return `
            <div class="commit-item">
              <div class="commit-header">
                <span class="commit-hash" title="${commit.hash}">${commit.shortHash}</span>
                <span class="commit-message">${this._escapeHtml(commit.message)}</span>
              </div>
              <div class="commit-meta">
                <span class="commit-author">👤 ${this._escapeHtml(commit.author)}</span>
                <span class="commit-date">📅 ${commitDate}</span>
                <span class="commit-stats">
                  <span class="stat-added">+${commit.filesAdded.length}</span>
                  <span class="stat-modified">~${commit.filesModified.length}</span>
                  <span class="stat-deleted">−${commit.filesDeleted.length}</span>
                </span>
              </div>
              <div class="commit-files">${filesHtml}</div>
            </div>
          `;
        }).join('');
        
        commitDetailsHtml = `
          <div class="commits-panel" data-job="${jobIndex}" style="display: none;">
            <div class="commits-list">
              ${commitsHtml}
            </div>
          </div>
        `;
      }
      
      return `
        <div class="job-section ${hasCommits ? 'expandable' : ''}" data-job="${jobIndex}">
          <div class="job-header">
            ${chevron}
            <span class="job-name">${this._escapeHtml(job.jobName)}</span>
            <span class="job-stats">
              <span class="stat">${job.commits} commits</span>
              <span class="stat stat-added">+${job.filesAdded}</span>
              <span class="stat stat-modified">~${job.filesModified}</span>
              <span class="stat stat-deleted">−${job.filesDeleted}</span>
            </span>
          </div>
          ${job.description ? `<div class="job-description">${this._escapeHtml(job.description)}</div>` : ''}
          ${commitDetailsHtml}
        </div>
      `;
    }).join('');
    
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Work Summary: ${this._escapeHtml(plan.name)}</title>
  <style>
    * { box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      padding: 20px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      line-height: 1.5;
      margin: 0;
    }
    
    /* Header */
    .header {
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 16px;
      margin-bottom: 20px;
    }
    .header h1 {
      margin: 0 0 8px 0;
      color: var(--vscode-textLink-foreground);
      font-size: 20px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .header .target-branch {
      font-size: 13px;
      opacity: 0.8;
    }
    
    /* Overall Stats */
    .stats-overview {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }
    .stat-card {
      background: var(--vscode-editor-selectionBackground);
      border-radius: 6px;
      padding: 12px;
      text-align: center;
    }
    .stat-card .value {
      font-size: 24px;
      font-weight: 600;
      color: var(--vscode-textLink-foreground);
    }
    .stat-card .label {
      font-size: 11px;
      opacity: 0.7;
      text-transform: uppercase;
      margin-top: 4px;
    }
    .stat-card.added .value { color: #4EC9B0; }
    .stat-card.modified .value { color: #DCDCAA; }
    .stat-card.deleted .value { color: #F48771; }
    
    /* Jobs Section */
    .jobs-section h2 {
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.7;
      margin: 0 0 12px 0;
    }
    
    .job-section {
      background: var(--vscode-editor-inactiveSelectionBackground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      margin-bottom: 8px;
      overflow: hidden;
    }
    .job-section.expandable .job-header {
      cursor: pointer;
    }
    .job-section.expandable .job-header:hover {
      background: var(--vscode-list-hoverBackground);
    }
    
    .job-header {
      display: flex;
      align-items: center;
      padding: 12px 14px;
      gap: 10px;
    }
    .job-chevron {
      font-size: 10px;
      transition: transform 0.2s;
      color: var(--vscode-foreground);
      opacity: 0.6;
    }
    .job-section.expanded .job-chevron {
      transform: rotate(90deg);
    }
    .job-name {
      flex: 1;
      font-weight: 500;
      color: var(--vscode-foreground);
    }
    .job-stats {
      display: flex;
      gap: 12px;
      font-size: 12px;
      opacity: 0.8;
    }
    .job-stats .stat { color: var(--vscode-foreground); }
    .job-stats .stat-added { color: #4EC9B0; }
    .job-stats .stat-modified { color: #DCDCAA; }
    .job-stats .stat-deleted { color: #F48771; }
    
    .job-description {
      padding: 0 14px 10px 34px;
      font-size: 12px;
      opacity: 0.7;
      font-style: italic;
    }
    
    /* Commits Panel */
    .commits-panel {
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
      max-height: 400px;
      overflow-y: auto;
    }
    .commits-list {
      padding: 8px;
    }
    
    .commit-item {
      background: var(--vscode-editor-selectionBackground);
      border-radius: 4px;
      padding: 10px;
      margin-bottom: 6px;
    }
    .commit-item:last-child {
      margin-bottom: 0;
    }
    
    .commit-header {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      margin-bottom: 6px;
    }
    .commit-hash {
      font-family: monospace;
      font-size: 11px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 2px 6px;
      border-radius: 3px;
      flex-shrink: 0;
    }
    .commit-message {
      font-size: 13px;
      word-break: break-word;
    }
    
    .commit-meta {
      display: flex;
      gap: 16px;
      font-size: 11px;
      opacity: 0.7;
      margin-bottom: 8px;
    }
    .commit-stats {
      display: flex;
      gap: 8px;
    }
    .commit-stats .stat-added { color: #4EC9B0; }
    .commit-stats .stat-modified { color: #DCDCAA; }
    .commit-stats .stat-deleted { color: #F48771; }
    
    .commit-files {
      font-family: monospace;
      font-size: 11px;
      padding: 6px 8px;
      background: var(--vscode-editor-background);
      border-radius: 3px;
    }
    .commit-file {
      padding: 2px 0;
      display: flex;
      gap: 8px;
    }
    .file-status { 
      font-weight: bold; 
      width: 12px;
    }
    .file-added .file-status { color: #4EC9B0; }
    .file-modified .file-status { color: #DCDCAA; }
    .file-deleted .file-status { color: #F48771; }
  </style>
</head>
<body>
  <div class="header">
    <h1>📊 Work Summary: ${this._escapeHtml(plan.name)}</h1>
    <div class="target-branch">Target Branch: <strong>${plan.targetBranch || plan.baseBranch || 'main'}</strong></div>
  </div>
  
  <div class="stats-overview">
    <div class="stat-card">
      <div class="value">${ws.totalCommits}</div>
      <div class="label">Commits</div>
    </div>
    <div class="stat-card added">
      <div class="value">+${ws.totalFilesAdded}</div>
      <div class="label">Added</div>
    </div>
    <div class="stat-card modified">
      <div class="value">~${ws.totalFilesModified}</div>
      <div class="label">Modified</div>
    </div>
    <div class="stat-card deleted">
      <div class="value">−${ws.totalFilesDeleted}</div>
      <div class="label">Deleted</div>
    </div>
  </div>
  
  <div class="jobs-section">
    <h2>Job-by-Job Breakdown (${ws.jobSummaries.length} jobs)</h2>
    ${jobSectionsHtml}
  </div>
  
  <script>
    // Handle job section expand/collapse
    document.querySelectorAll('.job-section.expandable .job-header').forEach(header => {
      header.addEventListener('click', () => {
        const section = header.closest('.job-section');
        const jobIndex = section.dataset.job;
        const panel = section.querySelector('.commits-panel');
        
        if (section.classList.contains('expanded')) {
          section.classList.remove('expanded');
          if (panel) panel.style.display = 'none';
        } else {
          section.classList.add('expanded');
          if (panel) panel.style.display = 'block';
        }
      });
    });
  </script>
</body>
</html>`;
  }
  
  private _update() {
    this._plan = this._getPlan(this._planId);
    
    if (!this._plan) {
      this._panel.webview.html = this._getErrorHtml('Plan not found');
      return;
    }
    
    // Get merge branches if callback is provided
    const mergeBranches = this._getMergeBranches ? this._getMergeBranches(this._planId) : undefined;
    
    this._panel.title = `Plan: ${this._plan.name}`;
    this._panel.webview.html = this._getHtml(this._plan, mergeBranches);
  }
  
  private _getErrorHtml(message: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { 
      font: 14px sans-serif; 
      padding: 20px; 
      color: var(--vscode-foreground);
      display: flex;
      align-items: center;
      justify-content: center;
      height: 80vh;
    }
    .error { 
      text-align: center; 
      opacity: 0.6; 
    }
  </style>
</head>
<body>
  <div class="error">${message}</div>
</body>
</html>`;
  }

  private _getLoadingHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; }
    body { 
      font: 13px -apple-system, Segoe UI, Roboto, sans-serif; 
      padding: 20px; 
      margin: 0; 
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .loading-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 60vh;
      gap: 20px;
    }
    .spinner {
      width: 48px;
      height: 48px;
      border: 3px solid var(--vscode-foreground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      opacity: 0.3;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .loading-text {
      font-size: 14px;
      opacity: 0.6;
    }
    .skeleton-container {
      width: 100%;
      max-width: 800px;
      margin-top: 30px;
    }
    .skeleton {
      background: linear-gradient(90deg, 
        var(--vscode-editor-background) 25%, 
        var(--vscode-widget-border, rgba(128,128,128,0.2)) 50%, 
        var(--vscode-editor-background) 75%);
      background-size: 200% 100%;
      animation: shimmer 1.5s infinite;
      border-radius: 4px;
    }
    @keyframes shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    .skeleton-header {
      height: 32px;
      width: 60%;
      margin-bottom: 20px;
    }
    .skeleton-diagram {
      height: 250px;
      width: 100%;
      margin-bottom: 20px;
      border-radius: 8px;
    }
    .skeleton-row {
      height: 16px;
      margin-bottom: 12px;
    }
    .skeleton-row:nth-child(1) { width: 80%; }
    .skeleton-row:nth-child(2) { width: 65%; }
    .skeleton-row:nth-child(3) { width: 75%; }
  </style>
</head>
<body>
  <div class="loading-container">
    <div class="spinner"></div>
    <div class="loading-text">Loading plan details...</div>
    <div class="skeleton-container">
      <div class="skeleton skeleton-header"></div>
      <div class="skeleton skeleton-diagram"></div>
      <div class="skeleton skeleton-row"></div>
      <div class="skeleton skeleton-row"></div>
      <div class="skeleton skeleton-row"></div>
    </div>
  </div>
</body>
</html>`;
  }
  
  private _getHtml(plan: Plan, mergeBranches?: Map<string, string>): string {
    const jobs = plan.jobs;
    const progress = Math.round((plan.completed.length / jobs.length) * 100);
    
    // Generate Mermaid diagram definition
    const mermaidDef = this._generateMermaidDiagram(plan, mergeBranches);
    
    // Build data maps for click handling
    const jobDataMap = this._buildJobDataMap(jobs);
    const subPlanDataMap = this._buildSubPlanDataMap(plan);
    
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <style>${getPlanDetailCss()}</style>
</head>
<body>
  <div class="header">
    <div class="header-title-row">
      <div class="plan-name">${this._escapeHtml(plan.name)}</div>
      <span class="status-badge ${plan.status}">${plan.status.toUpperCase()}</span>
    </div>
  </div>
  
  <div class="progress-section">
    <div class="progress-header">
      <span>Progress</span>
      <span>${plan.completed.length} / ${jobs.length} jobs completed</span>
    </div>
    <div class="progress-bar">
      <div class="progress-bar-fill" style="width: ${progress}%"></div>
    </div>
    <div class="progress-stats">
      <div class="stat"><div class="stat-dot completed"></div> ${plan.completed.length} completed</div>
      <div class="stat"><div class="stat-dot running"></div> ${plan.running.length} running</div>
      <div class="stat"><div class="stat-dot queued"></div> ${plan.queued.length} queued</div>
      ${plan.failed.length > 0 ? `<div class="stat"><div class="stat-dot failed"></div> ${plan.failed.length} failed</div>` : ''}
    </div>
  </div>
  
  <div class="legend">
    <div class="legend-section">
      <span class="legend-section-title">Nodes:</span>
      <div class="legend-item"><div class="legend-box pending"></div> Pending</div>
      <div class="legend-item"><div class="legend-box running"></div> Running</div>
      <div class="legend-item"><div class="legend-box completed"></div> Completed</div>
      <div class="legend-item"><div class="legend-box failed"></div> Failed</div>
    </div>
    <div class="legend-section">
      <span class="legend-section-title">Lines:</span>
      <div class="legend-item"><div class="legend-line pending"></div> Pending</div>
      <div class="legend-item"><div class="legend-line running"></div> Running</div>
      <div class="legend-item"><div class="legend-line completed"></div> Completed</div>
      <div class="legend-item"><div class="legend-line failed"></div> Failed</div>
    </div>
  </div>
  
  <div class="diagram-container">
    <div id="mermaid-diagram">
      <pre class="mermaid">
${mermaidDef}
      </pre>
    </div>
  </div>
  
  <div class="actions">
    <button class="action-btn cancel-btn" id="cancelBtn" ${['completed', 'succeeded', 'failed', 'canceled', 'partial'].includes(plan.status) ? 'disabled' : ''}>
      ⏹ Cancel Plan
    </button>
    <button class="action-btn retry-btn" id="retryBtn" ${!['failed', 'partial'].includes(plan.status) ? 'disabled' : ''}>
      ↻ Retry Failed Jobs
    </button>
    ${plan.parentPlanId ? '' : `<button class="action-btn delete-btn" id="deleteBtn">
      🗑 Delete Plan
    </button>`}
  </div>
  
  <script>${getPlanDetailJs(jobDataMap, subPlanDataMap)}</script>
</body>
</html>`;
  }
  
  /**
   * Build a map of sanitized job IDs to their data for click handling
   */
  private _buildJobDataMap(jobs: PlanJob[]): Record<string, { jobId: string | null, nestedPlanId?: string | null }> {
    const map: Record<string, { jobId: string | null, nestedPlanId?: string | null }> = {};
    for (const job of jobs) {
      // Use same sanitization as in _generateMermaidDiagram
      const sanitizedId = 'job_' + job.planJobId.replace(/[^a-zA-Z0-9]/g, '_');
      map[sanitizedId] = {
        jobId: job.jobId,
        nestedPlanId: job.nestedPlanId
      };
    }
    return map;
  }

  /**
   * Build a map of sanitized sub-plan IDs to their data for click handling
   */
  private _buildSubPlanDataMap(plan: Plan): Record<string, { subPlanId: string, childPlanId: string | null }> {
    const map: Record<string, { subPlanId: string, childPlanId: string | null }> = {};
    const subPlans = plan.subPlans || [];
    
    for (const sp of subPlans) {
      // Use same sanitization as in _generateMermaidDiagram
      const sanitizedId = 'subplan_' + sp.id.replace(/[^a-zA-Z0-9]/g, '_');
      
      // Get the child plan ID from runningSubPlans or completedSubPlans
      // The child plan ID is the full plan ID (parentId/subPlanId)
      let childPlanId: string | null = null;
      if (plan.runningSubPlans && plan.runningSubPlans[sp.id]) {
        childPlanId = plan.runningSubPlans[sp.id];
      } else if (plan.completedSubPlans?.includes(sp.id)) {
        // For completed sub-plans, construct the ID from parent + sub-plan ID
        childPlanId = `${plan.id}/${sp.id}`;
      }
      
      map[sanitizedId] = {
        subPlanId: sp.id,
        childPlanId
      };
    }
    return map;
  }
  
  /**
   * Generate Mermaid flowchart definition from plan
   */
  private _generateMermaidDiagram(plan: Plan, mergeBranches?: Map<string, string>): string {
    const jobs = plan.jobs;
    const subPlans = plan.subPlans || [];
    const lines: string[] = [];
    
    // Build levels for stage grouping (includes both jobs and sub-plans)
    const levels = this._buildLevels(jobs, subPlans);
    
    // Create job lookup map for status checks
    const jobMap = new Map<string, PlanJob>();
    for (const job of jobs) {
      jobMap.set(job.planJobId, job);
    }
    
    // Create sub-plan lookup map
    const subPlanMap = new Map<string, SubPlanSpec>();
    for (const sp of subPlans) {
      subPlanMap.set(sp.id, sp);
    }
    
    // Start flowchart (LR = left to right)
    lines.push('%%{init: {"flowchart": {"nodeSpacing": 20, "rankSpacing": 50}} }%%');
    lines.push('flowchart LR');
    
    // Get branch names
    const baseBranchName = plan.baseBranch || 'main';
    const targetBranchName = plan.targetBranch || baseBranchName;
    const showBaseBranch = baseBranchName !== targetBranchName;
    
    // Define style classes for nodes
    lines.push('');
    lines.push('  %% Style classes');
    lines.push('  classDef pending fill:#2d2d2d,stroke:#858585,stroke-width:2px,color:#cccccc');
    lines.push('  classDef running fill:#1e3a5f,stroke:#7DD3FC,stroke-width:3px,color:#7DD3FC');
    lines.push('  classDef completed fill:#1a3d2e,stroke:#4EC9B0,stroke-width:2px,color:#4EC9B0');
    lines.push('  classDef failed fill:#3d1f1f,stroke:#F48771,stroke-width:2px,color:#F48771');
    lines.push('  classDef baseBranchNode fill:#6e6e6e,stroke:#888888,stroke-width:2px,color:#ffffff');
    lines.push('  classDef targetBranchNode fill:#0e639c,stroke:#0e639c,stroke-width:2px,color:#ffffff');
    // Sub-plan specific styles (hexagon shape with slightly different colors)
    lines.push('  classDef subplanPending fill:#2a2a4a,stroke:#9370DB,stroke-width:2px,color:#cccccc');
    lines.push('  classDef subplanRunning fill:#2a3a5a,stroke:#7DD3FC,stroke-width:3px,color:#7DD3FC');
    lines.push('  classDef subplanCompleted fill:#1a3d2e,stroke:#4EC9B0,stroke-width:2px,color:#4EC9B0');
    lines.push('  classDef subplanFailed fill:#3d1f1f,stroke:#F48771,stroke-width:2px,color:#F48771');
    lines.push('');
    
    // Build ID map - sanitize IDs to be valid Mermaid identifiers
    const idMap = new Map<string, string>();
    for (const job of jobs) {
      const sanitizedId = 'job_' + job.planJobId.replace(/[^a-zA-Z0-9]/g, '_');
      idMap.set(job.planJobId, sanitizedId);
    }
    // Add sub-plans to ID map
    for (const sp of subPlans) {
      const sanitizedId = 'subplan_' + sp.id.replace(/[^a-zA-Z0-9]/g, '_');
      idMap.set(sp.id, sanitizedId);
    }
    
    // Add baseBranch node if different from targetBranch (on the far left)
    if (showBaseBranch) {
      lines.push('  subgraph Base["Base Branch"]');
      lines.push(`    BASE_BRANCH["${this._escapeForMermaid(baseBranchName)}"]`);
      lines.push('  end');
      lines.push('  class BASE_BRANCH baseBranchNode');
      lines.push('');
    }
    
    // Add targetBranch node as the source (left side, after base if shown)
    lines.push('  subgraph Source["Target Branch"]');
    lines.push(`    TARGET_SOURCE["${this._escapeForMermaid(targetBranchName)}"]`);
    lines.push('  end');
    lines.push('  class TARGET_SOURCE targetBranchNode');
    lines.push('');
    
    // Connect base to target if shown
    if (showBaseBranch) {
      lines.push('  BASE_BRANCH --> TARGET_SOURCE');
    }
    
    // Calculate the maximum label length across ALL stages for uniform width
    let globalMaxLen = 0;
    for (const level of levels) {
      for (const job of level.jobs) {
        const label = job.name || job.planJobId;
        if (label.length > globalMaxLen) globalMaxLen = label.length;
      }
      // Also check sub-plan names
      for (const sp of level.subPlans) {
        const label = sp.name || sp.id;
        const labelWithJobs = `📁 ${label} (${sp.jobs?.length || 0} jobs)`;
        if (labelWithJobs.length > globalMaxLen) globalMaxLen = labelWithJobs.length;
      }
    }
    // Add some padding for visual consistency
    globalMaxLen = Math.max(globalMaxLen, 25);
    
    // Helper to get sub-plan status class
    const getSubPlanStatus = (spId: string): string => {
      if (plan.completedSubPlans?.includes(spId)) return 'subplanCompleted';
      if (plan.runningSubPlans && plan.runningSubPlans[spId]) return 'subplanRunning';
      if (plan.failedSubPlans?.includes(spId)) return 'subplanFailed';
      return 'subplanPending';
    };
    
    // Add work unit nodes organized by stage (jobs and sub-plans together)
    levels.forEach((level, stageIndex) => {
      lines.push(`  subgraph Stage${stageIndex + 1}["Stage ${stageIndex + 1}"]`);
      
      // Add jobs in this stage
      for (const job of level.jobs) {
        const sanitizedId = idMap.get(job.planJobId)!;
        const rawLabel = job.name || job.planJobId;
        // Pad label to make boxes same width across ALL stages
        const paddedLabel = this._padLabel(rawLabel, globalMaxLen);
        
        // Use stadium shape [[ ]] for nested plans, regular box for others
        if (job.isNestedPlan || job.nestedPlanId) {
          lines.push(`    ${sanitizedId}[["${this._escapeForMermaid(paddedLabel)}"]]`);
        } else {
          lines.push(`    ${sanitizedId}["${this._escapeForMermaid(paddedLabel)}"]`);
        }
      }
      
      // Add sub-plans in this stage (hexagon shape)
      for (const sp of level.subPlans) {
        const sanitizedId = idMap.get(sp.id)!;
        const spName = sp.name || sp.id;
        const jobCount = sp.jobs?.length || 0;
        const rawLabel = `📁 ${spName} (${jobCount} jobs)`;
        const paddedLabel = this._padLabel(rawLabel, globalMaxLen);
        
        // Use hexagon shape {{ }} for sub-plans
        lines.push(`    ${sanitizedId}{{"${this._escapeForMermaid(paddedLabel)}"}}`);
      }
      
      lines.push('  end');
      lines.push('');
    });
    
    // Apply status classes to job nodes
    lines.push('  %% Apply status classes');
    for (const job of jobs) {
      const sanitizedId = idMap.get(job.planJobId)!;
      lines.push(`  class ${sanitizedId} ${job.status}`);
    }
    
    // Apply status classes to sub-plan nodes
    for (const sp of subPlans) {
      const sanitizedId = idMap.get(sp.id)!;
      lines.push(`  class ${sanitizedId} ${getSubPlanStatus(sp.id)}`);
    }
    lines.push('');
    
    // Add targetBranch node as the destination (right side)
    lines.push('  subgraph Destination["Target Branch"]');
    lines.push(`    TARGET_DEST["${this._escapeForMermaid(targetBranchName)}"]`);
    lines.push('  end');
    lines.push('  class TARGET_DEST targetBranchNode');
    lines.push('');
    
    // Add Work Summary node if plan has completed jobs with work summaries
    const hasWorkSummary = plan.aggregatedWorkSummary && plan.aggregatedWorkSummary.jobSummaries.length > 0;
    if (hasWorkSummary) {
      const ws = plan.aggregatedWorkSummary!;
      lines.push('  %% Work Summary style');
      lines.push('  classDef workSummaryNode fill:#1a3d2e,stroke:#4EC9B0,stroke-width:2px,color:#4EC9B0,cursor:pointer');
      lines.push('');
      lines.push('  subgraph Summary["Merged Work"]');
      lines.push(`    WORK_SUMMARY[["📊 Work Summary<br/>${ws.totalCommits} commits | +${ws.totalFilesAdded} -${ws.totalFilesDeleted} ~${ws.totalFilesModified}"]]`);
      lines.push('  end');
      lines.push('  class WORK_SUMMARY workSummaryNode');
      lines.push('');
    }
    
    // Track edges for styling - edge index starts at 0
    const edges: Array<{ from: string, to: string, status: string }> = [];
    
    // If base branch is shown, add edge from base to target (always completed/solid)
    if (showBaseBranch) {
      edges.push({ from: 'BASE_BRANCH', to: 'TARGET_SOURCE', status: 'completed' });
    }
    
    // Find root work units (jobs or sub-plans with no consumesFrom)
    const rootJobs = jobs.filter(j => j.consumesFrom.length === 0);
    const rootSubPlans = subPlans.filter(sp => sp.consumesFrom.length === 0);
    
    // Find leaf work units (jobs/sub-plans that nothing else consumes from)
    const allConsumedFrom = new Set<string>();
    for (const job of jobs) {
      job.consumesFrom.forEach(source => allConsumedFrom.add(source));
    }
    for (const sp of subPlans) {
      sp.consumesFrom.forEach(source => allConsumedFrom.add(source));
    }
    const leafJobs = jobs.filter(j => !allConsumedFrom.has(j.planJobId));
    const leafSubPlans = subPlans.filter(sp => !allConsumedFrom.has(sp.id));
    
    // Add edges
    lines.push('  %% Connections');
    
    // Connect targetBranch source to root jobs
    for (const job of rootJobs) {
      const sanitizedId = idMap.get(job.planJobId)!;
      lines.push(`  TARGET_SOURCE --> ${sanitizedId}`);
      // Edge status: green if job has started (running/completed/failed), pending otherwise
      const edgeStatus = ['running', 'completed', 'failed'].includes(job.status) ? 'completed' : 'pending';
      edges.push({ from: 'TARGET_SOURCE', to: sanitizedId, status: edgeStatus });
    }
    
    // Connect targetBranch source to root sub-plans
    for (const sp of rootSubPlans) {
      const sanitizedId = idMap.get(sp.id)!;
      lines.push(`  TARGET_SOURCE --> ${sanitizedId}`);
      const spStatus = getSubPlanStatus(sp.id);
      const edgeStatus = ['subplanRunning', 'subplanCompleted', 'subplanFailed'].includes(spStatus) ? 'completed' : 'pending';
      edges.push({ from: 'TARGET_SOURCE', to: sanitizedId, status: edgeStatus });
    }
    
    // Connect consumesFrom sources - all sources connect directly to the consuming work unit
    for (const job of jobs) {
      if (job.consumesFrom.length === 0) continue;
      
      const sanitizedJobId = idMap.get(job.planJobId)!;
      
      // Connect all sources directly to the job
      for (const sourceId of job.consumesFrom) {
        const sanitizedSourceId = idMap.get(sourceId);
        if (sanitizedSourceId) {
          lines.push(`  ${sanitizedSourceId} --> ${sanitizedJobId}`);
          // Check if source is a job or sub-plan
          const sourceJob = jobMap.get(sourceId);
          const sourceSubPlan = subPlanMap.get(sourceId);
          if (sourceJob) {
            edges.push({ from: sanitizedSourceId, to: sanitizedJobId, status: this._getEdgeStatus(sourceJob) });
          } else if (sourceSubPlan) {
            const spStatus = getSubPlanStatus(sourceId);
            edges.push({ from: sanitizedSourceId, to: sanitizedJobId, status: spStatus === 'subplanCompleted' ? 'completed' : 'pending' });
          }
        }
      }
    }
    
    // Connect sub-plan consumesFrom sources
    for (const sp of subPlans) {
      if (sp.consumesFrom.length === 0) continue;
      
      const sanitizedSpId = idMap.get(sp.id)!;
      
      for (const sourceId of sp.consumesFrom) {
        const sanitizedSourceId = idMap.get(sourceId);
        if (sanitizedSourceId) {
          lines.push(`  ${sanitizedSourceId} --> ${sanitizedSpId}`);
          const sourceJob = jobMap.get(sourceId);
          const sourceSubPlan = subPlanMap.get(sourceId);
          if (sourceJob) {
            edges.push({ from: sanitizedSourceId, to: sanitizedSpId, status: this._getEdgeStatus(sourceJob) });
          } else if (sourceSubPlan) {
            const spStatus = getSubPlanStatus(sourceId);
            edges.push({ from: sanitizedSourceId, to: sanitizedSpId, status: spStatus === 'subplanCompleted' ? 'completed' : 'pending' });
          }
        }
      }
    }
    
    // Connect leaf jobs to targetBranch destination (merge back)
    for (const job of leafJobs) {
      const sanitizedId = idMap.get(job.planJobId)!;
      lines.push(`  ${sanitizedId} --> TARGET_DEST`);
      edges.push({ from: sanitizedId, to: 'TARGET_DEST', status: this._getEdgeStatus(job) });
    }
    
    // Connect leaf sub-plans to targetBranch destination
    for (const sp of leafSubPlans) {
      const sanitizedId = idMap.get(sp.id)!;
      lines.push(`  ${sanitizedId} --> TARGET_DEST`);
      const spStatus = getSubPlanStatus(sp.id);
      edges.push({ from: sanitizedId, to: 'TARGET_DEST', status: spStatus === 'subplanCompleted' ? 'completed' : 'pending' });
    }
    
    // Connect TARGET_DEST to WORK_SUMMARY if there's a work summary
    if (hasWorkSummary) {
      lines.push(`  TARGET_DEST --> WORK_SUMMARY`);
      // Edge is completed if plan is done
      const summaryEdgeStatus = ['succeeded', 'completed', 'partial'].includes(plan.status) ? 'completed' : 'pending';
      edges.push({ from: 'TARGET_DEST', to: 'WORK_SUMMARY', status: summaryEdgeStatus });
    }
    
    // Apply link styles based on edge status (color + dash pattern for accessibility)
    lines.push('');
    lines.push('  %% Edge styles');
    edges.forEach((edge, index) => {
      const style = this._getEdgeStyle(edge.status);
      if (style.dasharray) {
        lines.push(`  linkStyle ${index} stroke:${style.color},stroke-width:2px,stroke-dasharray:${style.dasharray}`);
      } else {
        lines.push(`  linkStyle ${index} stroke:${style.color},stroke-width:2px`);
      }
    });
    
    return lines.join('\n');
  }
  
  /**
   * Pad a label with spaces to achieve a minimum width
   */
  private _padLabel(label: string, minLen: number): string {
    if (label.length >= minLen) return label;
    const padTotal = minLen - label.length;
    const padLeft = Math.floor(padTotal / 2);
    const padRight = padTotal - padLeft;
    // Use non-breaking spaces for padding
    return '\u00A0'.repeat(padLeft) + label + '\u00A0'.repeat(padRight);
  }
  
  /**
   * Get edge status based on source job status
   * Note: Failed jobs result in "pending" downstream edges since that work wasn't attempted
   */
  private _getEdgeStatus(job: PlanJob | undefined): string {
    if (!job) return 'pending';
    switch (job.status) {
      case 'completed':
        return 'completed';
      case 'failed':
        // Failed source means downstream edge is pending (work not attempted)
        return 'pending';
      case 'running':
        return 'running';
      default:
        return 'pending';
    }
  }
  
  /**
   * Get edge style (color and dash pattern) based on status
   * Returns: stroke color and stroke-dasharray for accessibility
   */
  private _getEdgeStyle(status: string): { color: string, dasharray: string } {
    switch (status) {
      case 'completed':
        // Solid line - green
        return { color: '#4EC9B0', dasharray: '' };
      case 'failed':
        // Dotted line - red  
        return { color: '#F48771', dasharray: '2,2' };
      case 'running':
        // Dash-dot line - blue
        return { color: '#7DD3FC', dasharray: '8,3,2,3' };
      default:
        // Dashed line - gray (pending)
        return { color: '#858585', dasharray: '5,3' };
    }
  }
  
  /**
   * Build levels from job consumesFrom for stage grouping
   * Includes both jobs and sub-plans as work units
   */
  private _buildLevels(jobs: PlanJob[], subPlans: SubPlanSpec[] = []): Array<{ jobs: PlanJob[], subPlans: SubPlanSpec[] }> {
    const levels: Array<{ jobs: PlanJob[], subPlans: SubPlanSpec[] }> = [];
    const placedJobs = new Set<string>();
    const placedSubPlans = new Set<string>();
    
    // Build set of all work unit IDs for dependency checking
    const allJobIds = new Set(jobs.map(j => j.planJobId));
    const allSubPlanIds = new Set(subPlans.map(sp => sp.id));
    
    while (placedJobs.size < jobs.length || placedSubPlans.size < subPlans.length) {
      // Find jobs ready for this level
      const levelJobs = jobs.filter(j => {
        if (placedJobs.has(j.planJobId)) return false;
        // Ready if all consumesFrom sources are placed (jobs or sub-plans)
        return j.consumesFrom.every(source => 
          placedJobs.has(source) || placedSubPlans.has(source) || 
          (!allJobIds.has(source) && !allSubPlanIds.has(source)) // External source
        );
      });
      
      // Find sub-plans ready for this level
      const levelSubPlans = subPlans.filter(sp => {
        if (placedSubPlans.has(sp.id)) return false;
        // Ready if all consumesFrom sources are placed
        return sp.consumesFrom.every(source =>
          placedJobs.has(source) || placedSubPlans.has(source) ||
          (!allJobIds.has(source) && !allSubPlanIds.has(source))
        );
      });
      
      // If nothing is ready, break to avoid infinite loop (shouldn't happen with valid plans)
      if (levelJobs.length === 0 && levelSubPlans.length === 0) {
        // Add remaining as final level
        const remainingJobs = jobs.filter(j => !placedJobs.has(j.planJobId));
        const remainingSubPlans = subPlans.filter(sp => !placedSubPlans.has(sp.id));
        if (remainingJobs.length > 0 || remainingSubPlans.length > 0) {
          levels.push({ jobs: remainingJobs, subPlans: remainingSubPlans });
        }
        break;
      }
      
      levels.push({ jobs: levelJobs, subPlans: levelSubPlans });
      levelJobs.forEach(j => placedJobs.add(j.planJobId));
      levelSubPlans.forEach(sp => placedSubPlans.add(sp.id));
    }
    
    return levels;
  }
  
  /**
   * Escape string for use in Mermaid labels
   */
  private _escapeForMermaid(str: string): string {
    return str
      .replace(/"/g, "'")
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br/>')
      .replace(/[#]/g, '');
  }
  
  private _escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
