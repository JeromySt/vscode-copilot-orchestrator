/**
 * @fileoverview DAGs View Provider
 * 
 * Displays a list of DAGs with their execution status in the sidebar.
 * Supports clicking to open detailed DAG view.
 * 
 * @module ui/dagsViewProvider
 */

import * as vscode from 'vscode';
import { DagRunner, DagInstance, DagStatus, NodeStatus } from '../dag';

/**
 * DAGs View Provider - webview in the sidebar showing DAGs list
 */
export class DagsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'orchestrator.dagsView';
  
  private _view?: vscode.WebviewView;
  private _refreshTimer?: NodeJS.Timeout;
  
  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _dagRunner: DagRunner
  ) {
    // Listen for DAG events to refresh
    _dagRunner.on('dagCreated', () => this.refresh());
    _dagRunner.on('dagCompleted', () => this.refresh());
    _dagRunner.on('dagDeleted', () => this.refresh());
    _dagRunner.on('nodeTransition', () => this.scheduleRefresh());
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
        case 'openDag':
          vscode.commands.executeCommand('orchestrator.showDagDetails', message.dagId);
          break;
        case 'cancelDag':
          vscode.commands.executeCommand('orchestrator.cancelDag', message.dagId);
          break;
        case 'deleteDag':
          vscode.commands.executeCommand('orchestrator.deleteDag', message.dagId);
          break;
        case 'refresh':
          this.refresh();
          break;
      }
    });
    
    // Send initial data
    setTimeout(() => this.refresh(), 100);
    
    // Setup periodic refresh for running DAGs
    this._refreshTimer = setInterval(() => {
      const hasRunning = this._dagRunner.getAll().some(dag => {
        const sm = this._dagRunner.getStateMachine(dag.id);
        const status = sm?.computeDagStatus();
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
    });
  }
  
  /**
   * Schedule a debounced refresh
   */
  private scheduleRefresh() {
    // Debounce rapid updates
    if (this._refreshTimer) return;
    setTimeout(() => this.refresh(), 100);
  }
  
  /**
   * Refresh the view with current DAG data
   */
  refresh() {
    if (!this._view) return;
    
    const dags = this._dagRunner.getAll();
    
    // Sort by creation time (newest first)
    dags.sort((a, b) => b.createdAt - a.createdAt);
    
    // Default counts when state machine is not available
    const defaultCounts: Record<NodeStatus, number> = {
      pending: 0, ready: 0, scheduled: 0, running: 0,
      succeeded: 0, failed: 0, blocked: 0, canceled: 0
    };
    
    // Build DAG data for webview
    const dagData = dags.map(dag => {
      const sm = this._dagRunner.getStateMachine(dag.id);
      const status = sm?.computeDagStatus() || 'pending';
      const counts = sm?.getStatusCounts() || defaultCounts;
      
      const total = dag.nodes.size;
      const completed = counts.succeeded + counts.failed + counts.blocked;
      const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
      
      return {
        id: dag.id,
        name: dag.spec.name,
        status,
        nodes: dag.nodes.size,
        progress,
        counts: {
          succeeded: counts.succeeded,
          failed: counts.failed,
          running: counts.running,
          pending: counts.pending + counts.ready,
        },
        createdAt: dag.createdAt,
        startedAt: dag.startedAt,
        endedAt: dag.endedAt,
        isSubDag: !!dag.parentDagId,
      };
    });
    
    // Filter out sub-DAGs (they're shown under their parent)
    const topLevelDags = dagData.filter(d => !d.isSubDag);
    
    this._view.webview.postMessage({
      type: 'update',
      dags: topLevelDags,
      total: topLevelDags.length,
      running: topLevelDags.filter(d => d.status === 'running').length,
    });
  }
  
  private _getHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
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
    .dag-item {
      padding: 8px;
      margin-bottom: 8px;
      border-radius: 4px;
      background: var(--vscode-list-hoverBackground);
      cursor: pointer;
      border-left: 3px solid transparent;
    }
    .dag-item:hover {
      background: var(--vscode-list-activeSelectionBackground);
    }
    .dag-item.running { border-left-color: var(--vscode-progressBar-background); }
    .dag-item.succeeded { border-left-color: var(--vscode-testing-iconPassed); }
    .dag-item.failed { border-left-color: var(--vscode-testing-iconFailed); }
    .dag-item.partial { border-left-color: var(--vscode-editorWarning-foreground); }
    .dag-item.canceled { border-left-color: var(--vscode-descriptionForeground); }
    
    .dag-name { 
      font-weight: 600; 
      margin-bottom: 4px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .dag-status {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 8px;
      text-transform: uppercase;
    }
    .dag-status.running { background: rgba(0, 122, 204, 0.2); color: var(--vscode-progressBar-background); }
    .dag-status.succeeded { background: rgba(78, 201, 176, 0.2); color: var(--vscode-testing-iconPassed); }
    .dag-status.failed { background: rgba(244, 135, 113, 0.2); color: var(--vscode-testing-iconFailed); }
    .dag-status.partial { background: rgba(255, 204, 0, 0.2); color: var(--vscode-editorWarning-foreground); }
    .dag-status.pending { background: rgba(133, 133, 133, 0.2); color: var(--vscode-descriptionForeground); }
    
    .dag-details {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      gap: 12px;
      margin-top: 4px;
    }
    .dag-progress {
      height: 3px;
      background: var(--vscode-progressBar-background);
      opacity: 0.3;
      border-radius: 2px;
      margin-top: 6px;
    }
    .dag-progress-bar {
      height: 100%;
      background: var(--vscode-progressBar-background);
      border-radius: 2px;
      transition: width 0.3s ease;
    }
    .dag-progress-bar.succeeded { background: var(--vscode-testing-iconPassed); }
    .dag-progress-bar.failed { background: var(--vscode-testing-iconFailed); }
    
    .empty { 
      padding: 20px; 
      text-align: center; 
      opacity: 0.6; 
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
    <h3>DAGs</h3>
    <span class="pill" id="badge">0 total</span>
  </div>
  <div id="dags"><div class="empty">No DAGs yet</div></div>
  
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
      
      const dags = ev.data.dags || [];
      document.getElementById('badge').textContent = dags.length + ' total';
      
      const container = document.getElementById('dags');
      
      if (dags.length === 0) {
        container.innerHTML = '<div class="empty">No DAGs yet. Create one via MCP tools.</div>';
        return;
      }
      
      container.innerHTML = dags.map(dag => {
        const progressClass = dag.status === 'failed' ? 'failed' : 
                             dag.status === 'succeeded' ? 'succeeded' : '';
        
        return \`
          <div class="dag-item \${dag.status}" data-id="\${dag.id}">
            <div class="dag-name">
              <span>\${dag.name}</span>
              <span class="dag-status \${dag.status}">\${dag.status}</span>
            </div>
            <div class="dag-details">
              <span>\${dag.nodes} nodes</span>
              <span>✓ \${dag.counts.succeeded}</span>
              <span>✗ \${dag.counts.failed}</span>
              <span>⏳ \${dag.counts.running}</span>
              \${dag.startedAt ? '<span>' + formatDuration(dag.startedAt, dag.endedAt) + '</span>' : ''}
            </div>
            <div class="dag-progress">
              <div class="dag-progress-bar \${progressClass}" style="width: \${dag.progress}%"></div>
            </div>
          </div>
        \`;
      }).join('');
      
      // Add click handlers
      document.querySelectorAll('.dag-item').forEach(el => {
        el.addEventListener('click', () => {
          vscode.postMessage({ type: 'openDag', dagId: el.dataset.id });
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
