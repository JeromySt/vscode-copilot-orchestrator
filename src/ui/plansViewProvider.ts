/**
 * @fileoverview Plans view Provider
 * 
 * Displays a list of Plans with their execution status in the sidebar.
 * Supports clicking to open detailed Plan view.
 * 
 * @module ui/plansViewProvider
 */

import * as vscode from 'vscode';
import { PlanRunner, PlanInstance, PlanStatus, NodeStatus } from '\.\./plan';
import { planDetailPanel } from './panels/planDetailPanel';
import { NodeDetailPanel } from './panels/nodeDetailPanel';

/**
 * Plans view Provider - webview in the sidebar showing Plans list
 */
export class plansViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'orchestrator.plansView';
  
  private _view?: vscode.WebviewView;
  private _refreshTimer?: NodeJS.Timeout;
  private _debounceTimer?: NodeJS.Timeout;
  
  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _planRunner: PlanRunner
  ) {
    // Listen for Plan events to refresh
    _planRunner.on('planCreated', () => this.refresh());
    _planRunner.on('planCompleted', () => this.refresh());
    _planRunner.on('planDeleted', (planId) => {
      // Close any open panels for this Plan
      planDetailPanel.closeForPlan(planId);
      NodeDetailPanel.closeForPlan(planId);
      this.refresh();
    });
    _planRunner.on('nodeTransition', () => this.scheduleRefresh());
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
        case 'deletePlan':
          vscode.commands.executeCommand('orchestrator.deletePlan', message.planId);
          break;
        case 'refresh':
          this.refresh();
          break;
      }
    });
    
    // Send initial data
    setTimeout(() => this.refresh(), 100);
    
    // Setup periodic refresh for running Plans
    this._refreshTimer = setInterval(() => {
      const hasRunning = this._planRunner.getAll().some(plan => {
        const sm = this._planRunner.getStateMachine(plan.id);
        const status = sm?.computePlanStatus();
        return status === 'running' || status === 'pending';
      });
      
      if (hasRunning) {
        this.refresh();
      }
    }, 2000);
    
    webviewView.onDidDispose(() => {
      if (this._refreshTimer) {
        clearInterval(this._refreshTimer);
      }
      if (this._debounceTimer) {
        clearTimeout(this._debounceTimer);
      }
    });
  }
  
  /**
   * Schedule a debounced refresh
   */
  private scheduleRefresh() {
    // Debounce rapid updates
    if (this._debounceTimer) return;
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = undefined;
      this.refresh();
    }, 100);
  }
  
  /**
   * Refresh the view with current Plan data
   */
  refresh() {
    if (!this._view) return;
    
    const Plans = this._planRunner.getAll();
    
    // Sort by creation time (newest first)
    Plans.sort((a, b) => b.createdAt - a.createdAt);
    
    // Default counts when state machine is not available
    const defaultCounts: Record<NodeStatus, number> = {
      pending: 0, ready: 0, scheduled: 0, running: 0,
      succeeded: 0, failed: 0, blocked: 0, canceled: 0
    };
    
    // Build Plan data for webview
    const planData = Plans.map(plan => {
      const sm = this._planRunner.getStateMachine(plan.id);
      const status = sm?.computePlanStatus() || 'pending';
      const counts = sm?.getStatusCounts() || defaultCounts;
      
      const total = plan.nodes.size;
      const completed = counts.succeeded + counts.failed + counts.blocked;
      const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
      
      return {
        id: plan.id,
        name: plan.spec.name,
        status,
        nodes: plan.nodes.size,
        progress,
        counts: {
          succeeded: counts.succeeded,
          failed: counts.failed,
          running: counts.running,
          pending: counts.pending + counts.ready,
        },
        createdAt: plan.createdAt,
        startedAt: plan.startedAt,
        endedAt: this._planRunner.getEffectiveEndedAt(plan.id) || plan.endedAt,
        issubPlan: !!plan.parentPlanId,
      };
    });
    
    // Filter out sub-plans (they're shown under their parent)
    const topLevelPlans = planData.filter(d => !d.issubPlan);
    
    this._view.webview.postMessage({
      type: 'update',
      Plans: topLevelPlans,
      total: topLevelPlans.length,
      running: topLevelPlans.filter(d => d.status === 'running').length,
    });
  }
  
  private _getHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>
    body { 
      font: 12px var(--vscode-font-family); 
      padding: 8px; 
      margin: 0; 
      color: var(--vscode-foreground); 
    }
    .header { 
      display: flex; 
      gap: 8px; 
      margin-bottom: 12px; 
      align-items: center; 
    }
    .header h3 { margin: 0; }
    .pill { 
      padding: 2px 8px; 
      border-radius: 10px; 
      font-size: 11px; 
      background: var(--vscode-badge-background); 
      color: var(--vscode-badge-foreground); 
    }
    .plan-item {
      padding: 8px;
      margin-bottom: 8px;
      border-radius: 4px;
      background: var(--vscode-list-hoverBackground);
      cursor: pointer;
      border-left: 3px solid transparent;
    }
    .plan-item:hover {
      background: var(--vscode-list-activeSelectionBackground);
    }
    .plan-item.running { border-left-color: var(--vscode-progressBar-background); }
    .plan-item.succeeded { border-left-color: var(--vscode-testing-iconPassed); }
    .plan-item.failed { border-left-color: var(--vscode-testing-iconFailed); }
    .plan-item.partial { border-left-color: var(--vscode-editorWarning-foreground); }
    .plan-item.canceled { border-left-color: var(--vscode-descriptionForeground); }
    
    .plan-name { 
      font-weight: 600; 
      margin-bottom: 4px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .plan-status {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 8px;
      text-transform: uppercase;
    }
    .plan-status.running { background: rgba(0, 122, 204, 0.2); color: var(--vscode-progressBar-background); }
    .plan-status.succeeded { background: rgba(78, 201, 176, 0.2); color: var(--vscode-testing-iconPassed); }
    .plan-status.failed { background: rgba(244, 135, 113, 0.2); color: var(--vscode-testing-iconFailed); }
    .plan-status.partial { background: rgba(255, 204, 0, 0.2); color: var(--vscode-editorWarning-foreground); }
    .plan-status.pending { background: rgba(133, 133, 133, 0.2); color: var(--vscode-descriptionForeground); }
    
    .plan-details {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      gap: 12px;
      margin-top: 4px;
    }
    .plan-progress {
      height: 3px;
      background: var(--vscode-progressBar-background);
      opacity: 0.3;
      border-radius: 2px;
      margin-top: 6px;
    }
    .plan-progress-bar {
      height: 100%;
      background: var(--vscode-progressBar-background);
      border-radius: 2px;
      transition: width 0.3s ease;
    }
    .plan-progress-bar.succeeded { background: var(--vscode-testing-iconPassed); }
    .plan-progress-bar.failed { background: var(--vscode-testing-iconFailed); }
    
    .empty { 
      padding: 20px; 
      text-align: center; 
      opacity: 0.6; 
    }
    .empty code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 6px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
    }
    .actions {
      margin-top: 8px;
      display: flex;
      gap: 8px;
    }
    .action-btn {
      font-size: 10px;
      padding: 2px 6px;
      border: none;
      border-radius: 3px;
      cursor: pointer;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .action-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
  </style>
</head>
<body>
  <div class="header">
    <h3>Plans</h3>
    <span class="pill" id="badge">0 total</span>
  </div>
  <div id="plans"><div class="empty">No plans yet. Use <code>create_copilot_plan</code> or <code>create_copilot_job</code> MCP tool.</div></div>
  
  <script>
    const vscode = acquireVsCodeApi();
    
    function formatTime(ms) {
      if (!ms) return '';
      const date = new Date(ms);
      return date.toLocaleTimeString();
    }
    
    function formatDuration(start, end) {
      if (!start) return '';
      const duration = (end || Date.now()) - start;
      const secs = Math.floor(duration / 1000);
      if (secs < 60) return secs + 's';
      const mins = Math.floor(secs / 60);
      const remSecs = secs % 60;
      return mins + 'm ' + remSecs + 's';
    }
    
    window.addEventListener('message', ev => {
      if (ev.data.type !== 'update') return;
      
      const Plans = ev.data.Plans || [];
      document.getElementById('badge').textContent = Plans.length + ' total';
      
      const container = document.getElementById('plans');
      
      if (Plans.length === 0) {
        container.innerHTML = '<div class="empty">No plans yet. Use <code>create_copilot_plan</code> or <code>create_copilot_job</code> MCP tool.</div>';
        return;
      }
      
      container.innerHTML = Plans.map(plan => {
        const progressClass = plan.status === 'failed' ? 'failed' : 
                             plan.status === 'succeeded' ? 'succeeded' : '';
        
        return \`
          <div class="plan-item \${plan.status}" data-id="\${plan.id}">
            <div class="plan-name">
              <span>\${plan.name}</span>
              <span class="plan-status \${plan.status}">\${plan.status}</span>
            </div>
            <div class="plan-details">
              <span>\${plan.nodes} nodes</span>
              <span>✓ \${plan.counts.succeeded}</span>
              <span>✗ \${plan.counts.failed}</span>
              <span>⏳ \${plan.counts.running}</span>
              \${plan.startedAt ? '<span>' + formatDuration(plan.startedAt, plan.endedAt) + '</span>' : ''}
            </div>
            <div class="plan-progress">
              <div class="plan-progress-bar \${progressClass}" style="width: \${plan.progress}%"></div>
            </div>
          </div>
        \`;
      }).join('');
      
      // Add click handlers
      document.querySelectorAll('.plan-item').forEach(el => {
        el.addEventListener('click', () => {
          vscode.postMessage({ type: 'openPlan', planId: el.dataset.id });
        });
      });
    });
    
    // Request initial data
    vscode.postMessage({ type: 'refresh' });
  </script>
</body>
</html>`;
  }
}
