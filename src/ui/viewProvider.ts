
import * as vscode from 'vscode';
import { Job } from '../core/jobRunner';

// Simple data provider interface
export interface JobDataProvider {
  getJobs(): Job[];
}

export class JobsViewProvider implements vscode.WebviewViewProvider { 
  public static readonly viewType='orchestrator.jobsView'; 
  private _view?:vscode.WebviewView; 
  private _dataProvider?: JobDataProvider;
  private _outputChannel: vscode.OutputChannel;
  
  constructor(private readonly _context:vscode.ExtensionContext){
    this._outputChannel = vscode.window.createOutputChannel('Copilot Jobs Panel');
    this._outputChannel.appendLine('=== Jobs Panel Initialized ===');
  }
  
  setDataProvider(provider: JobDataProvider) {
    this._outputChannel.appendLine('[setDataProvider] Setting data provider');
    this._dataProvider = provider;
    const jobs = provider.getJobs();
    this._outputChannel.appendLine(`[setDataProvider] Data provider has ${jobs.length} jobs available`);
    this.refresh();
  }
  
  resolveWebviewView(view:vscode.WebviewView, context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken){ 
    this._outputChannel.appendLine('[resolveWebviewView] Panel view is being resolved');
    this._view=view; 
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: []
    }; 
    
    this._outputChannel.appendLine('[resolveWebviewView] Setting HTML content');
    view.webview.html = this.getSimpleHtml(); 
    
    // Handle clicks - just open dashboard
    view.webview.onDidReceiveMessage(message => {
      this._outputChannel.appendLine(`[onDidReceiveMessage] ${message.type}: ${message.jobId || ''}`);
      
      if (message.type === 'openJob') {
        vscode.commands.executeCommand('orchestrator.showJobDetails', message.jobId);
      } else if (message.type === 'openDashboard') {
        vscode.commands.executeCommand('orchestrator.openDashboard');
      } else if (message.type === 'refresh') {
        this.refresh();
      }
    });
    
    // Send initial data after short delay
    setTimeout(() => this.refresh(), 300);
  }
  
  // Public method to trigger refresh
  refresh() { 
    if (!this._view || !this._dataProvider) return;
    
    const jobs = this._dataProvider.getJobs();
    this._view.webview.postMessage({ 
      type: 'update',
      jobs: jobs.map(j => ({
        id: j.id,
        name: j.name,
        status: j.status,
        currentStep: j.currentStep,
        duration: j.endedAt && j.startedAt ? Math.round((j.endedAt - j.startedAt) / 1000) : null,
        startedAt: j.startedAt
      })),
      running: jobs.filter(j=>j.status==='running').length 
    }); 
  }
  
  private getSimpleHtml() {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font: 12px sans-serif; padding: 8px; margin: 0; color: var(--vscode-foreground); }
    .header { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; }
    .pill { padding: 2px 8px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 11px; }
    .job-item { padding: 8px; margin-bottom: 4px; border-radius: 4px; cursor: pointer; border: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
    .job-item:hover { background: var(--vscode-list-hoverBackground); }
    .job-name { font-weight: 600; margin-bottom: 4px; font-size: 11px; }
    .job-details { font-size: 10px; opacity: 0.8; display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
    .status-badge { display: inline-flex; align-items: center; padding: 2px 6px; border-radius: 3px; font-weight: 500; font-size: 10px; }
    .status-badge.failed { background: rgba(244, 135, 113, 0.15); border-left: 3px solid var(--vscode-testing-iconFailed, #F48771); color: var(--vscode-testing-iconFailed, #F48771); }
    .status-badge.succeeded { background: rgba(78, 201, 176, 0.15); border-left: 3px solid var(--vscode-testing-iconPassed, #4EC9B0); color: var(--vscode-testing-iconPassed, #4EC9B0); }
    .status-badge.running { background: rgba(75, 166, 251, 0.15); border-left: 3px solid var(--vscode-progressBar-background, #4BA6FB); color: #7DD3FC; }
    .status-badge.queued { background: rgba(133, 133, 133, 0.1); border-left: 3px solid var(--vscode-descriptionForeground, #858585); color: var(--vscode-descriptionForeground, #858585); }
    .status-badge.canceled { background: rgba(133, 133, 133, 0.1); border-left: 3px solid var(--vscode-descriptionForeground, #858585); color: var(--vscode-descriptionForeground, #858585); }
    .empty { padding: 20px; text-align: center; opacity: 0.6; }
    .open-dashboard { margin-top: 12px; padding: 6px 12px; width: 100%; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; }
    .open-dashboard:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <div class="header">
    <h3 style="margin:0">Jobs</h3>
    <span class="pill" id="badge">0 total</span>
  </div>
  <div id="jobs"></div>
  <button class="open-dashboard" id="openDashboard">Open Dashboard</button>
  
  <script>
    const vscode = acquireVsCodeApi();
    
    function formatDuration(seconds) {
      if (seconds < 60) return seconds + 's';
      if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
      const hours = Math.floor(seconds / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      return hours + 'h ' + mins + 'm';
    }
    
    function updateRunningDurations() {
      document.querySelectorAll('.job-item').forEach(el => {
        const startedAt = parseInt(el.getAttribute('data-started'));
        if (startedAt && el.getAttribute('data-status') === 'running') {
          const elapsed = Math.floor((Date.now() - startedAt) / 1000);
          const durSpan = el.querySelector('.duration');
          if (durSpan) {
            durSpan.textContent = formatDuration(elapsed);
          }
        }
      });
    }
    
    // Update running durations every second
    setInterval(updateRunningDurations, 1000);
    
    window.addEventListener('message', ev => {
      if (ev.data.type === 'update') {
        const jobs = ev.data.jobs || [];
        document.getElementById('badge').textContent = jobs.length + ' total (' + ev.data.running + ' running)';
        
        const container = document.getElementById('jobs');
        if (jobs.length === 0) {
          container.innerHTML = '<div class="empty">No jobs yet</div>';
        } else {
          container.innerHTML = jobs.map(j => {
            const dur = j.duration ? formatDuration(j.duration) : '';
            return '<div class="job-item" data-id="' + j.id + '" data-status="' + j.status + '" data-started="' + (j.startedAt || '') + '">' +
              '<div class="job-name">' + j.name + '</div>' +
              '<div class="job-details">' +
                '<span class="status-badge ' + j.status + '">' + j.status + '</span>' +
                (j.currentStep ? '<span>' + j.currentStep + '</span>' : '') +
                (j.status === 'running' ? '<span class="duration">calculating...</span>' : (dur ? '<span>' + dur + '</span>' : '')) +
              '</div>' +
            '</div>';
          }).join('');
          
          // Initial update of running durations
          updateRunningDurations();
          
          // Add click handlers
          document.querySelectorAll('.job-item').forEach(el => {
            el.addEventListener('click', () => {
              vscode.postMessage({ type: 'openJob', jobId: el.getAttribute('data-id') });
            });
          });
        }
      }
    });
    
    document.getElementById('openDashboard').addEventListener('click', () => {
      vscode.postMessage({ type: 'openDashboard' });
    });
    
    // Request initial data
    vscode.postMessage({ type: 'refresh' });
  </script>
</body>
</html>`;
  }
}
