
import * as vscode from 'vscode';
import { Job } from '../core/jobRunner';

export function createDashboard(context: vscode.ExtensionContext) {
  const panel = vscode.window.createWebviewPanel(
    'copilotOrchestrator',
    'Copilot Orchestrator',
    vscode.ViewColumn.Active,
    { enableScripts: true }
  );
  
  panel.webview.onDidReceiveMessage(message => {
    if (message.command === 'showJobDetails') {
      vscode.commands.executeCommand('orchestrator.showJobDetails', message.jobId);
    } else if (message.command === 'contextMenu') {
      showContextMenu(message.jobId, context);
    }
  });
  
  panel.webview.html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font: 12px/1.4 -apple-system, Segoe UI, Roboto, sans-serif;
      padding: 16px;
      margin: 0;
    }
    h2 { margin: 0 0 16px 0; }
    .row {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 12px;
    }
    .pill {
      padding: 2px 6px;
      border-radius: 6px;
      background: #4443;
      font-size: 11px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      border-bottom: 1px solid #4444;
      padding: 6px 8px;
      text-align: left;
    }
    th {
      font-weight: 600;
      font-size: 11px;
    }
    td {
      font-size: 11px;
    }
    .empty {
      padding: 32px;
      text-align: center;
      opacity: 0.6;
    }
    tr.clickable {
      cursor: pointer;
    }
    tr.clickable:hover {
      background: #4442;
    }
    .status-failed { color: #f48771; }
    .status-succeeded { color: #89d185; }
    .status-running { color: #3794ff; }
    .status-queued { color: #cccccc; }
    .status-canceled { color: #cccccc; }
  </style>
</head>
<body>
  <h2>Copilot Orchestrator</h2>
  <div class="row">
    <span class="pill" id="running">0 running</span>
    <span class="pill" id="total">0 total</span>
  </div>
  <div id="content">
    <div class="empty">No jobs yet</div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const content = document.getElementById('content');
    const runningEl = document.getElementById('running');
    const totalEl = document.getElementById('total');
    
    function formatDuration(seconds) {
      if (seconds < 0) return '0s';
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = Math.floor(seconds % 60);
      const parts = [];
      if (hours > 0) parts.push(hours + 'h');
      if (minutes > 0) parts.push(minutes + 'm');
      if (secs > 0 || parts.length === 0) parts.push(secs + 's');
      return parts.join(' ');
    }
    
    window.addEventListener('message', ev => {
      const data = ev.data;
      const jobs = data.jobs || [];
      
      runningEl.textContent = (data.running || 0) + ' running';
      totalEl.textContent = jobs.length + ' total';
      
      if (jobs.length === 0) {
        content.innerHTML = '<div class="empty">No jobs yet. Create one to get started!</div>';
      } else {
        content.innerHTML = \`<table>
          <thead>
            <tr>
              <th>Job</th>
              <th>Task</th>
              <th>Status</th>
              <th>Step</th>
              <th>Duration</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody id="rows"></tbody>
        </table>\`;
        
        const rows = document.getElementById('rows');
        rows.innerHTML = jobs.map(j => {
          const duration = j.endedAt && j.startedAt 
            ? formatDuration(Math.round((j.endedAt - j.startedAt) / 1000))
            : j.startedAt ? 'running...' : '';
          const started = j.startedAt 
            ? new Date(j.startedAt).toLocaleTimeString()
            : '';
          const step = j.currentStep || '-';
          const stepInfo = j.stepStatuses ? 'Pre:' + (j.stepStatuses.prechecks || '-') + ' Work:' + (j.stepStatuses.work || '-') + ' Post:' + (j.stepStatuses.postchecks || '-') : '';
          
          return \`<tr class="clickable" onclick="showJob('\${j.id}')" oncontextmenu="showContextMenu('\${j.id}', event)" title="Steps: \${stepInfo}">
            <td>\${j.name}</td>
            <td>\${j.task || 'Unnamed task'}</td>
            <td class="status-\${j.status}">\${j.status}</td>
            <td>\${step}</td>
            <td>\${duration}</td>
            <td>\${started}</td>
          </tr>\`;
        }).join('');
      }
    });
    
    function showJob(jobId) {
      vscode.postMessage({ command: 'showJobDetails', jobId: jobId });
    }
    
    function showContextMenu(jobId, event) {
      event.preventDefault();
      vscode.postMessage({ command: 'contextMenu', jobId: jobId });
    }
  </script>
</body>
</html>`;

  return {
    update(jobs: Job[]) {
      panel.webview.postMessage({
        jobs,
        running: jobs.filter(j => j.status === 'running').length
      });
    },
    dispose() {
      panel.dispose();
    }
  };
}

async function showContextMenu(jobId: string, context: vscode.ExtensionContext) {
  const items: vscode.QuickPickItem[] = [
    { label: '$(output) Show Logs', description: 'View job details and logs' },
    { label: '$(filter) Show Section', description: 'View specific log section' },
    { label: '$(debug-stop) Cancel', description: 'Stop job' },
    { label: '$(debug-restart) Retry', description: 'Retry this job' },
    { label: '$(folder-opened) Open Worktree', description: 'Open job worktree folder' },
    { label: '$(trash) Delete', description: 'Remove this job' }
  ];
  
  const choice = await vscode.window.showQuickPick(items, { placeHolder: `Job: ${jobId}` });
  if (!choice) return;
  
  if (choice.label.includes('Show Logs')) {
    vscode.commands.executeCommand('orchestrator.showJobDetails', jobId);
  } else if (choice.label.includes('Show Section')) {
    vscode.commands.executeCommand('orchestrator.showJobSection', jobId);
  } else if (choice.label.includes('Cancel')) {
    vscode.commands.executeCommand('orchestrator.cancelJob', jobId);
  } else if (choice.label.includes('Retry')) {
    vscode.commands.executeCommand('orchestrator.retryJob', jobId);
  } else if (choice.label.includes('Open Worktree')) {
    vscode.commands.executeCommand('orchestrator.openJobWorktree', jobId);
  } else if (choice.label.includes('Delete')) {
    vscode.commands.executeCommand('orchestrator.deleteJob', jobId);
  }
}
