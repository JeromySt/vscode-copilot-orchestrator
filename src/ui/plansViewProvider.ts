/**
 * @fileoverview Plans View Provider for the sidebar.
 * 
 * Displays a list of job plans with their execution status.
 * Plans can be clicked to open a detailed plan view panel.
 * 
 * @module ui/plansViewProvider
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Plan job details from plans.json
 */
export interface PlanJob {
  planJobId: string;
  jobId: string | null;
  nestedPlanId?: string | null;
  isNestedPlan?: boolean;
  name?: string;
  task?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  consumesFrom: string[];
  plan?: {
    name?: string;
    maxParallel?: number;
    jobs?: PlanJob[];
  };
}

/**
 * Sub-plan specification (from parent plan spec)
 */
export interface SubPlanSpec {
  id: string;
  name?: string;
  consumesFrom: string[];
  maxParallel?: number;
  jobs: Array<{
    id: string;
    name?: string;
    task: string;
    consumesFrom: string[];
  }>;
  subPlans?: SubPlanSpec[];
}

/**
 * Plan data structure from plans.json
 */
export interface Plan {
  id: string;
  name: string;
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'canceled' | 'succeeded';
  maxParallel: number;
  jobs: PlanJob[];
  queued: string[];
  running: string[];
  completed: string[];
  failed: string[];
  startedAt: number | null;
  endedAt: number | null;
  baseBranch?: string;
  targetBranch?: string;
  /** Whether the final RI merge to targetBranch completed successfully */
  riMergeCompleted?: boolean;
  /** Sub-plan specifications from the plan spec */
  subPlans?: SubPlanSpec[];
  /** Sub-plans that are pending (not yet triggered) */
  pendingSubPlans?: string[];
  /** Sub-plans currently running (subPlanId -> childPlanId) */
  runningSubPlans?: Record<string, string>;
  /** Sub-plans that completed */
  completedSubPlans?: string[];
  /** Sub-plans that failed */
  failedSubPlans?: string[];
  /** Parent plan ID if this is a sub-plan */
  parentPlanId?: string;
  /** Aggregated work summary across all completed jobs */
  aggregatedWorkSummary?: {
    totalCommits: number;
    totalFilesAdded: number;
    totalFilesModified: number;
    totalFilesDeleted: number;
    jobSummaries: Array<{
      jobId: string;
      jobName: string;
      commits: number;
      filesAdded: number;
      filesModified: number;
      filesDeleted: number;
      description: string;
      /** Detailed commit information */
      commitDetails?: Array<{
        hash: string;
        shortHash: string;
        message: string;
        author: string;
        date: string;
        filesAdded: string[];
        filesModified: string[];
        filesDeleted: string[];
      }>;
    }>;
  };
}

/**
 * Data provider interface for plans
 */
export interface PlanDataProvider {
  getPlans(): Plan[];
  getPlan(id: string): Plan | undefined;
}

/**
 * Plans View Provider - webview in the sidebar showing plans list
 */
export class PlansViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'orchestrator.plansView';
  
  private _view?: vscode.WebviewView;
  private _dataProvider?: PlanDataProvider;
  private _fileWatcher?: vscode.FileSystemWatcher;
  
  constructor(private readonly _context: vscode.ExtensionContext) {}
  
  setDataProvider(provider: PlanDataProvider) {
    this._dataProvider = provider;
    this.refresh();
  }
  
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: []
    };
    
    webviewView.webview.html = this._getHtml();
    
    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(message => {
      switch (message.type) {
        case 'openPlan':
          vscode.commands.executeCommand('orchestrator.showPlanDetails', message.planId);
          break;
        case 'cancelPlan':
          vscode.commands.executeCommand('orchestrator.cancelPlan', message.planId);
          break;
        case 'refresh':
          this.refresh();
          break;
      }
    });
    
    // Initial data
    setTimeout(() => this.refresh(), 300);
  }
  
  refresh() {
    if (!this._view || !this._dataProvider) return;
    
    const allPlans = this._dataProvider.getPlans();
    
    // Separate root plans from child plans (sub-plans that have been launched)
    // Child plans have IDs with '/' in them (e.g., "parent-id/subplan-id")
    const rootPlans = allPlans.filter(p => !p.id.includes('/'));
    const childPlans = allPlans.filter(p => p.id.includes('/'));
    
    // Build a map of parent -> launched children for easy lookup
    const launchedChildrenMap = new Map<string, typeof childPlans>();
    for (const child of childPlans) {
      // Extract parent ID from child ID (format: "parentId/subplanId")
      const parentId = child.id.substring(0, child.id.lastIndexOf('/'));
      const siblings = launchedChildrenMap.get(parentId) || [];
      siblings.push(child);
      launchedChildrenMap.set(parentId, siblings);
    }
    
    // Helper to determine sub-plan status
    const getSubPlanStatus = (plan: Plan, subPlanId: string): string => {
      if (plan.completedSubPlans?.includes(subPlanId)) return 'completed';
      if (plan.runningSubPlans && plan.runningSubPlans[subPlanId]) return 'running';
      if (plan.failedSubPlans?.includes(subPlanId)) return 'failed';
      return 'pending';
    };
    
    // Helper function to build plan tree data including sub-plan specs
    const buildPlanTree = (plan: Plan, depth: number = 0): any => {
      // Get launched child plans
      const launchedChildren = launchedChildrenMap.get(plan.id) || [];
      
      // Get sub-plan specs that haven't been launched yet (from spec)
      const subPlanSpecs = plan.subPlans || [];
      const launchedSubPlanIds = new Set(Object.keys(plan.runningSubPlans || {}));
      const completedSubPlanIds = new Set(plan.completedSubPlans || []);
      const failedSubPlanIds = new Set(plan.failedSubPlans || []);
      
      // Build children array: launched child plans + pending sub-plan specs
      const children: any[] = [];
      
      // Add launched child plans (fully expanded with their jobs)
      for (const child of launchedChildren) {
        children.push(buildPlanTree(child, depth + 1));
      }
      
      // Add pending sub-plan specs (not yet launched)
      for (const spSpec of subPlanSpecs) {
        const status = getSubPlanStatus(plan, spSpec.id);
        // Only show pending sub-plans as specs (running/completed are shown as launched children)
        if (status === 'pending') {
          children.push({
            id: `${plan.id}/${spSpec.id}`,
            name: spSpec.name || spSpec.id,
            status: 'pending',
            jobCount: spSpec.jobs?.length || 0,
            completed: 0,
            running: 0,
            failed: 0,
            queued: spSpec.jobs?.length || 0,
            progress: 0,
            depth: depth + 1,
            isSubPlan: true,
            isSubPlanSpec: true, // Marker that this is a spec, not launched
            consumesFrom: spSpec.consumesFrom,
            children: [] // Sub-plan specs don't show their jobs until launched
          });
        }
      }
      
      return {
        id: plan.id,
        name: plan.name || plan.id.split('/').pop() || plan.id,
        status: plan.status,
        jobCount: plan.jobs.length,
        completed: plan.completed.length,
        running: plan.running.length,
        failed: plan.failed.length,
        queued: plan.queued.length,
        progress: plan.jobs.length > 0 ? Math.round((plan.completed.length / plan.jobs.length) * 100) : 0,
        depth: depth,
        isSubPlan: depth > 0,
        // Sub-plan tracking
        pendingSubPlans: plan.pendingSubPlans?.length || 0,
        runningSubPlans: Object.keys(plan.runningSubPlans || {}).length,
        completedSubPlans: plan.completedSubPlans?.length || 0,
        failedSubPlans: plan.failedSubPlans?.length || 0,
        // Children (launched sub-plans + pending sub-plan specs)
        children
      };
    };
    
    const planTree = rootPlans.map(p => buildPlanTree(p));
    
    this._view.webview.postMessage({
      type: 'update',
      plans: planTree
    });
  }
  
  private _getHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { 
      font: 11px sans-serif; 
      padding: 6px; 
      margin: 0; 
      color: var(--vscode-foreground); 
    }
    .header { 
      display: flex; 
      gap: 6px; 
      margin-bottom: 8px; 
      align-items: center; 
    }
    .header h3 {
      margin: 0;
      font-size: 12px;
      white-space: nowrap;
    }
    .pill { 
      padding: 1px 6px; 
      border-radius: 8px; 
      background: var(--vscode-badge-background); 
      color: var(--vscode-badge-foreground); 
      font-size: 10px;
      white-space: nowrap;
    }
    .plan-tree { }
    .plan-item { 
      padding: 6px 8px; 
      margin-bottom: 3px; 
      border-radius: 4px; 
      cursor: pointer; 
      border: 1px solid var(--vscode-panel-border); 
      background: var(--vscode-editor-background);
      transition: background 0.15s;
      overflow: hidden;
    }
    .plan-item:hover { 
      background: var(--vscode-list-hoverBackground); 
    }
    .plan-item.subplan {
      margin-left: 12px;
      border-left: 2px solid var(--vscode-activityBar-activeBorder, #0078d4);
    }
    .plan-item.subplan-spec {
      border-left-style: dashed;
      opacity: 0.85;
      background: rgba(147, 112, 219, 0.05);
    }
    .plan-name { 
      font-weight: 600; 
      font-size: 11px;
      display: flex;
      align-items: flex-start;
      flex-wrap: wrap;
      gap: 4px;
      line-height: 1.3;
    }
    .plan-name-text {
      word-break: break-word;
      flex: 1;
      min-width: 0;
    }
    .plan-stats { 
      font-size: 10px; 
      opacity: 0.8; 
      display: flex; 
      gap: 6px; 
      flex-wrap: wrap;
      margin-top: 3px;
    }
    .stat {
      display: flex;
      align-items: center;
      gap: 3px;
    }
    .status-badge { 
      display: inline-flex; 
      align-items: center; 
      padding: 2px 6px; 
      border-radius: 3px; 
      font-weight: 500; 
      font-size: 10px; 
    }
    .status-badge.failed, .status-badge.partial { 
      background: rgba(244, 135, 113, 0.15); 
      border-left: 3px solid var(--vscode-testing-iconFailed, #F48771); 
      color: var(--vscode-testing-iconFailed, #F48771); 
    }
    .status-badge.succeeded, .status-badge.completed { 
      background: rgba(78, 201, 176, 0.15); 
      border-left: 3px solid var(--vscode-testing-iconPassed, #4EC9B0); 
      color: var(--vscode-testing-iconPassed, #4EC9B0); 
    }
    .status-badge.running { 
      background: rgba(75, 166, 251, 0.15); 
      border-left: 3px solid var(--vscode-progressBar-background, #4BA6FB); 
      color: #7DD3FC; 
    }
    .status-badge.queued { 
      background: rgba(133, 133, 133, 0.1); 
      border-left: 3px solid var(--vscode-descriptionForeground, #858585); 
      color: var(--vscode-descriptionForeground, #858585); 
    }
    .status-badge.canceled { 
      background: rgba(133, 133, 133, 0.1); 
      border-left: 3px solid var(--vscode-descriptionForeground, #858585); 
      color: var(--vscode-descriptionForeground, #858585); 
    }
    .progress-bar {
      height: 3px;
      border-radius: 2px;
      background: var(--vscode-progressBar-background);
      opacity: 0.3;
      margin-top: 6px;
      overflow: hidden;
    }
    .progress-bar-fill {
      height: 100%;
      background: var(--vscode-progressBar-background);
      transition: width 0.3s ease;
    }
    .subplan-indicator {
      font-size: 9px;
      opacity: 0.7;
      margin-left: 4px;
    }
    .empty { 
      padding: 20px; 
      text-align: center; 
      opacity: 0.6; 
    }
    .icon {
      display: inline-block;
      width: 12px;
      opacity: 0.8;
    }
    .icon-completed { color: var(--vscode-testing-iconPassed, #4EC9B0); }
    .icon-running { color: #7DD3FC; }
    .icon-failed { color: var(--vscode-testing-iconFailed, #F48771); }
    .icon-queued { color: var(--vscode-descriptionForeground, #858585); }
    .icon-subplan { color: var(--vscode-activityBar-activeBorder, #0078d4); }
    .children-container {
      margin-top: 4px;
    }
  </style>
</head>
<body>
  <div class="header">
    <h3 style="margin:0">Plans</h3>
    <span class="pill" id="badge">0 plans</span>
  </div>
  <div id="plans" class="plan-tree"></div>
  
  <script>
    const vscode = acquireVsCodeApi();
    
    // Render a plan item recursively
    function renderPlan(p, depth = 0) {
      const isSubPlan = depth > 0;
      const indent = depth * 16;
      
      let subPlanInfo = '';
      if (p.pendingSubPlans > 0 || p.runningSubPlans > 0 || p.completedSubPlans > 0 || p.failedSubPlans > 0) {
        const parts = [];
        if (p.completedSubPlans > 0) parts.push('<span class="icon icon-completed">✓</span>' + p.completedSubPlans);
        if (p.runningSubPlans > 0) parts.push('<span class="icon icon-running">◐</span>' + p.runningSubPlans);
        if (p.failedSubPlans > 0) parts.push('<span class="icon icon-failed">✗</span>' + p.failedSubPlans);
        if (p.pendingSubPlans > 0) parts.push('<span class="icon icon-queued">○</span>' + p.pendingSubPlans);
        subPlanInfo = '<span class="subplan-indicator">' + parts.join(' ') + '</span>';
      }
      
      // Different rendering for sub-plan specs (not yet launched) vs actual plans
      const isSubPlanSpec = p.isSubPlanSpec === true;
      const icon = isSubPlanSpec ? '📋 ' : (isSubPlan ? '↳ ' : '');
      const itemClass = 'plan-item' + (isSubPlan ? ' subplan' : '') + (isSubPlanSpec ? ' subplan-spec' : '');
      
      // For sub-plan specs, show source info instead of progress stats
      let statsHtml = '';
      if (isSubPlanSpec) {
        statsHtml = '<div class="plan-stats">' +
          '<span class="stat">📁 ' + p.jobCount + '</span>' +
        '</div>';
      } else {
        statsHtml = '<div class="plan-stats">' +
          '<span class="stat"><span class="icon icon-completed">✓</span>' + p.completed + '/' + p.jobCount + '</span>' +
          (p.failed > 0 ? '<span class="stat"><span class="icon icon-failed">✗</span>' + p.failed + '</span>' : '') +
          (p.running > 0 ? '<span class="stat"><span class="icon icon-running">◐</span>' + p.running + '</span>' : '') +
        '</div>' +
        '<div class="progress-bar"><div class="progress-bar-fill" style="width:' + p.progress + '%"></div></div>';
      }
      
      let html = '<div class="' + itemClass + '" data-id="' + p.id + '" style="margin-left:' + indent + 'px">' +
        '<div class="plan-name">' +
          '<span class="status-badge ' + p.status + '">' + p.status + '</span>' +
          '<span class="plan-name-text">' + icon + p.name + '</span>' +
        '</div>' +
        (subPlanInfo ? '<div class="plan-stats">' + subPlanInfo + '</div>' : '') +
        statsHtml +
      '</div>';
      
      // Render children recursively
      if (p.children && p.children.length > 0) {
        html += '<div class="children-container">';
        for (const child of p.children) {
          html += renderPlan(child, depth + 1);
        }
        html += '</div>';
      }
      
      return html;
    }
    
    // Count total plans including nested
    function countPlans(plans) {
      let count = plans.length;
      for (const p of plans) {
        if (p.children) count += countPlans(p.children);
      }
      return count;
    }
    
    window.addEventListener('message', ev => {
      if (ev.data.type === 'update') {
        const plans = ev.data.plans || [];
        const total = countPlans(plans);
        document.getElementById('badge').textContent = total + ' plan' + (total !== 1 ? 's' : '');
        
        const container = document.getElementById('plans');
        if (plans.length === 0) {
          container.innerHTML = '<div class="empty">No plans yet<br><small>Create a plan using Copilot Chat</small></div>';
        } else {
          container.innerHTML = plans.map(p => renderPlan(p)).join('');
          
          // Add click handlers
          document.querySelectorAll('.plan-item').forEach(el => {
            el.addEventListener('click', (e) => {
              e.stopPropagation();
              vscode.postMessage({ type: 'openPlan', planId: el.getAttribute('data-id') });
            });
          });
        }
      }
    });
    
    // Request initial data
    vscode.postMessage({ type: 'refresh' });
  </script>
</body>
</html>`;
  }
}
