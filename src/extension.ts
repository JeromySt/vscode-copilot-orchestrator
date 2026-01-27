import * as vscode from 'vscode';
import * as cp from 'child_process';
import { randomUUID } from 'crypto';
import { JobRunner } from './jobRunner';
import { createDashboard } from './webview';
import { JobsViewProvider } from './viewProvider';
import { OrchestratorNotebookSerializer, registerNotebookController } from './notebook';
import { detectWorkspace } from './detector';
import { TaskRunner } from './taskRunner';
import { listConflicts, checkoutSide, stageAll, commit } from './gitApi';
import { attachStatusBar } from './statusBar';
import { PlanRunner } from './planRunner';
import { startHttp } from './httpServer';
import { ensureCopilotCliInteractive, registerCopilotCliCheck } from './cliCheck';

let mcpProc: cp.ChildProcess | undefined;
let mcpStatusItem: vscode.StatusBarItem | undefined;

export async function activate(context: vscode.ExtensionContext) {
  console.log('Copilot Orchestrator extension is activating...');
  
  const runner = new JobRunner(context);
  const plans = new PlanRunner(runner);
  attachStatusBar(context, runner);

  // Sidebar view with data provider pattern
  const jobsView = new JobsViewProvider(context);
  
  // Set data provider BEFORE registering the webview provider to avoid race conditions
  jobsView.setDataProvider({
    getJobs: () => runner.list()
  });
  
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(JobsViewProvider.viewType, jobsView));
  
  // Dashboard - only create when command is invoked, not on startup
  let dashboard: ReturnType<typeof createDashboard> | undefined;
  
  // Job details panels - track by jobId to reuse existing tabs
  const jobDetailPanels = new Map<string, vscode.WebviewPanel>();
  
  // Global process stats cache - only refresh when job detail panels are open
  let globalProcessStatsCache: any[] = [];
  let lastProcessStatsRefresh = 0;
  const PROCESS_STATS_CACHE_MS = 2000; // Cache for 2 seconds
  
  const updateUI = () => { 
    const jobs = runner.list(); 
    if (dashboard) dashboard.update(jobs); 
    jobsView.refresh();
    
    // Refresh job detail panels only if the job status changed (not every second)
    // This prevents breaking the JavaScript intervals in the webview
    for (const [jobId, panel] of jobDetailPanels.entries()) {
      const job = jobs.find(j => j.id === jobId);
      if (job) {
        // Store last known status to detect changes
        const lastStatus = (panel as any)._lastStatus;
        if (lastStatus !== job.status) {
          (panel as any)._lastStatus = job.status;
          panel.webview.html = getJobDetailsHtml(job, panel.webview);
        }
      }
    }
  };
  setInterval(updateUI, 1000);

  // Notebook
  context.subscriptions.push(vscode.workspace.registerNotebookSerializer('orchestrator-notebook', new OrchestratorNotebookSerializer(), { transientOutputs: false }));
  registerNotebookController(context, runner);

  // Local HTTP for MCP shim
  try {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || context.globalStorageUri.fsPath;
    const pathM = require('path'); const fsM = require('fs');
    const cfgPath = pathM.join(ws, '.orchestrator', 'config.json');
    const cfg = fsM.existsSync(cfgPath)? JSON.parse(fsM.readFileSync(cfgPath,'utf8')) : { http: { enabled: true, host: '127.0.0.1', port: 39217 } };
    if (cfg.http?.enabled) {
      const srv = startHttp(runner, plans, cfg.http.host||'127.0.0.1', cfg.http.port||39217);
      context.subscriptions.push({ dispose(){ srv.close(); } });
    }
  } catch {}

  // MCP HTTP Server auto-start
  mcpStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  mcpStatusItem.text = 'MCP: stopped'; 
  mcpStatusItem.tooltip = 'Copilot Orchestrator MCP HTTP Server'; 
  mcpStatusItem.show();
  context.subscriptions.push(mcpStatusItem);
  
  function startMcpIfEnabled() { 
    try { 
      const cfg = vscode.workspace.getConfiguration('copilotOrchestrator.mcp'); 
      if (!cfg.get('enabled')) {
        console.log('MCP server disabled in settings');
        return;
      }
      
      const host = String(cfg.get('host') || '127.0.0.1'); 
      const port = Number(cfg.get('port') || 39217);
      const mcpPort = port + 1; // MCP on port 39218 by default
      const serverPath = vscode.Uri.joinPath(context.extensionUri, 'server', 'mcp-server.js').fsPath;
      
      console.log(`Starting MCP HTTP server: ${serverPath}`);
      console.log(`MCP will listen on: http://127.0.0.1:${mcpPort}`);
      console.log(`Target Orchestrator API: http://${host}:${port}`);
      
      mcpProc = cp.spawn('node', [serverPath], { 
        env: { 
          ...process.env, 
          ORCH_HOST: host, 
          ORCH_PORT: String(port),
          MCP_PORT: String(mcpPort)
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      mcpProc.stderr?.on('data', (data) => {
        console.log(`[MCP] ${data.toString().trim()}`);
      });
      
      mcpProc.stdout?.on('data', (data) => {
        console.log(`[MCP] ${data.toString().trim()}`);
      });
      
      mcpProc.on('spawn', () => { 
        console.log('MCP HTTP server spawned successfully');
        if (mcpStatusItem) {
          mcpStatusItem.text = `MCP: http://127.0.0.1:${mcpPort}`; 
          mcpStatusItem.tooltip = `MCP HTTP Server\nEndpoint: http://127.0.0.1:${mcpPort}\nOrchestrator API: http://${host}:${port}\nClick for tools info`;
          mcpStatusItem.command = 'orchestrator.mcp.howToConnect';
        }
      });
      
      mcpProc.on('error', (err) => {
        console.error('MCP server error:', err);
        if (mcpStatusItem) mcpStatusItem.text = 'MCP: error';
      });
      
      mcpProc.on('exit', (code, signal) => { 
        console.log(`MCP server exited: code=${code}, signal=${signal}`);
        if (mcpStatusItem) mcpStatusItem.text = 'MCP: stopped'; 
      });
      
      context.subscriptions.push({ 
        dispose() { 
          try { 
            mcpProc?.kill(); 
          } catch {} 
        } 
      });
      
    } catch (err) { 
      console.error('Failed to start MCP server:', err);
      vscode.window.showWarningMessage('Failed to start MCP HTTP server. Check console for details.'); 
    } 
  }
  
  startMcpIfEnabled();

  // Copilot CLI check (Option 4 – pre-flight + interactive)
  registerCopilotCliCheck(context);
  await ensureCopilotCliInteractive('startup');

  // Check and prompt for MCP server registration with GitHub Copilot
  await promptMcpServerRegistration(context);

  // Commands
  context.subscriptions.push(vscode.commands.registerCommand('orchestrator.startJob', async () => {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; 
    if (!ws) return vscode.window.showErrorMessage('Open a workspace with a Git repo.');
    
    const det = detectWorkspace(ws);
    const jobName = await vscode.window.showInputBox({ 
      prompt: 'Job name (for display)', 
      value: `job-${Date.now()}` 
    }) || `job-${Date.now()}`;
    
    // Get current git branch and detect default branch
    const { execSync } = require('child_process');
    let currentBranch = 'main';
    let defaultBranch = 'main';
    
    try {
      currentBranch = execSync('git branch --show-current', { cwd: ws, encoding: 'utf-8' }).trim();
      
      // Try to detect the default branch from remote HEAD
      try {
        const remoteHead = execSync('git symbolic-ref refs/remotes/origin/HEAD 2>nul', { cwd: ws, encoding: 'utf-8' }).trim();
        defaultBranch = remoteHead.replace('refs/remotes/origin/', '');
      } catch {
        // Fallback: check which common default branch exists
        const branches = execSync('git branch -r', { cwd: ws, encoding: 'utf-8' });
        if (branches.includes('origin/main')) {
          defaultBranch = 'main';
        } else if (branches.includes('origin/master')) {
          defaultBranch = 'master';
        } else if (branches.includes('origin/develop')) {
          defaultBranch = 'develop';
        }
      }
    } catch (e) {
      console.error('Failed to get git branch info:', e);
    }
    
    // Determine base and target branches automatically
    const isOnDefaultBranch = currentBranch === defaultBranch;
    let baseBranch = currentBranch;
    let targetBranch = currentBranch;
    
    if (isOnDefaultBranch) {
      // On default branch: create a new feature branch
      const friendlyName = jobName.replace(/\W+/g, '-').toLowerCase();
      targetBranch = `feature/${friendlyName}`;
      baseBranch = defaultBranch;
    }
    // else: already on feature branch, use it as both base and target
    
    const jobId = randomUUID();
    const conf = require('fs').existsSync(require('path').join(ws,'.orchestrator','config.json')) 
      ? JSON.parse(require('fs').readFileSync(require('path').join(ws,'.orchestrator','config.json'),'utf8')) 
      : { worktreeRoot: '.worktrees' };
    
    runner.enqueue({ 
      id: jobId,
      name: jobName,
      task: 'generic-work', 
      inputs: { 
        repoPath: ws, 
        baseBranch, 
        targetBranch, 
        worktreeRoot: (conf.worktreeRoot||'.worktrees'), 
        instructions: '' 
      }, 
      policy: { 
        useJust: true, 
        steps: { 
          prechecks: det.steps.pre, 
          work: det.steps.work, 
          postchecks: det.steps.post 
        } 
      } 
    });
    
    vscode.window.showInformationMessage(`Job "${jobName}" queued on ${targetBranch} (ID: ${jobId.substring(0, 8)}...)`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('orchestrator.inspectStatus', () => updateUI()));

  context.subscriptions.push(vscode.commands.registerCommand('orchestrator.showJobDetails', async (jobId?: string) => {
    if (!jobId) {
      const jobs = runner.list();
      if (jobs.length === 0) {
        vscode.window.showInformationMessage('No jobs available');
        return;
      }
      const items = jobs.map(j => ({ 
        label: j.name, 
        description: `${j.status} - ${j.id.substring(0, 8)}...`, 
        detail: j.task,
        jobId: j.id
      }));
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select a job to inspect' });
      if (!pick) return;
      jobId = (pick as any).jobId;
    }
    
    const job = runner.list().find(j => j.id === jobId);
    if (!job) {
      vscode.window.showErrorMessage(`Job ${jobId} not found`);
      return;
    }
    
    // TypeScript safety - at this point jobId must be defined
    if (!jobId) return;
    
    // Check if panel already exists for this job - if so, reveal it
    const existingPanel = jobDetailPanels.get(jobId);
    if (existingPanel) {
      existingPanel.reveal(vscode.ViewColumn.Beside);
      // Update the content
      existingPanel.webview.html = getJobDetailsHtml(job, existingPanel.webview);
      return;
    }
    
    // Create new job details panel
    const panel = vscode.window.createWebviewPanel(
      'jobDetails',
      `Job: ${job.name}`,
      vscode.ViewColumn.One,
      { enableScripts: true, enableCommandUris: true }
    );
    
    jobDetailPanels.set(jobId, panel);
    
    // Initialize last known status for change detection
    (panel as any)._lastStatus = job.status;
    
    // Clean up when panel is disposed
    panel.onDidDispose(() => {
      jobDetailPanels.delete(jobId!);
    });
    
    // Handle messages from webview
    panel.webview.onDidReceiveMessage(async message => {
      if (message.command === 'getLogContent') {
        // Load log content and send it back to webview
        const logPath = message.logPath;
        const section = message.section; // FULL, PRECHECKS, WORK, or POSTCHECKS
        const isRunning = message.isRunning;
        
        if (require('fs').existsSync(logPath)) {
          const fs = require('fs');
          let logContent = fs.readFileSync(logPath, 'utf-8');
          
          // Filter by section if not FULL
          if (section && section !== 'FULL') {
            const sectionStart = logContent.indexOf(`========== ${section} SECTION START ==========`);
            const sectionEnd = logContent.indexOf(`========== ${section} SECTION END ==========`);
            
            if (sectionStart !== -1 && sectionEnd !== -1) {
              logContent = logContent.substring(sectionStart, sectionEnd + `========== ${section} SECTION END ==========`.length);
            } else if (sectionStart !== -1) {
              logContent = logContent.substring(sectionStart);
            } else {
              logContent = `No ${section} section found in log`;
            }
          }
          
          panel.webview.postMessage({ 
            command: 'updateLogContent', 
            logPath: logPath, 
            section: section,
            content: logContent 
          });
        }
      } else if (message.command === 'copyToClipboard') {
        // Copy session ID to clipboard
        await vscode.env.clipboard.writeText(message.text);
        vscode.window.showInformationMessage(`Copied to clipboard: ${message.text.substring(0, 12)}...`);
      } else if (message.command === 'openLog') {
        const logPath = message.logPath;
        const section = message.section; // Optional: PRECHECKS, WORK, or POSTCHECKS
        const isRunning = message.isRunning; // Whether the job/stage is currently running
        
        if (require('fs').existsSync(logPath)) {
          const doc = await vscode.workspace.openTextDocument(logPath);
          const editor = await vscode.window.showTextDocument(doc, { 
            preview: false, 
            viewColumn: vscode.ViewColumn.Beside 
          });
          
          // Scroll to end if running, or to section if specified
          if (editor) {
            if (isRunning) {
              // Scroll to end for running logs
              const lastLine = doc.lineCount - 1;
              const lastChar = doc.lineAt(lastLine).text.length;
              editor.selection = new vscode.Selection(lastLine, lastChar, lastLine, lastChar);
              editor.revealRange(new vscode.Range(lastLine, 0, lastLine, 0), vscode.TextEditorRevealType.InCenter);
              
              // Set up auto-refresh for running logs
              const refreshInterval = setInterval(async () => {
                const currentJob = runner.list().find(j => j.id === jobId);
                if (!currentJob || (currentJob.status !== 'running' && currentJob.status !== 'queued')) {
                  clearInterval(refreshInterval);
                  return;
                }
                
                // Check if this editor is still visible
                const stillVisible = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === logPath);
                if (!stillVisible) {
                  clearInterval(refreshInterval);
                  return;
                }
                
                // Reload and scroll to end
                try {
                  await vscode.commands.executeCommand('workbench.action.files.revert');
                  const activeEditor = vscode.window.activeTextEditor;
                  if (activeEditor && activeEditor.document.uri.fsPath === logPath) {
                    const newLastLine = activeEditor.document.lineCount - 1;
                    const newLastChar = activeEditor.document.lineAt(newLastLine).text.length;
                    activeEditor.selection = new vscode.Selection(newLastLine, newLastChar, newLastLine, newLastChar);
                    activeEditor.revealRange(new vscode.Range(newLastLine, 0, newLastLine, 0), vscode.TextEditorRevealType.InCenter);
                  }
                } catch (e) {
                  // Editor might be closed
                  clearInterval(refreshInterval);
                }
              }, 2000);
            } else if (section) {
              // If section specified and not running, scroll to that section
              const text = doc.getText();
              const sectionStart = text.indexOf(`========== ${section} SECTION START ==========`);
              if (sectionStart !== -1) {
                const startPos = doc.positionAt(sectionStart);
                editor.selection = new vscode.Selection(startPos, startPos);
                editor.revealRange(new vscode.Range(startPos, startPos), vscode.TextEditorRevealType.AtTop);
              }
            }
          }
        }
      } else if (message.command === 'cancelJob') {
        await vscode.commands.executeCommand('orchestrator.cancelJob', message.jobId);
      } else if (message.command === 'retryJob') {
        await vscode.commands.executeCommand('orchestrator.retryJob', message.jobId);
      } else if (message.command === 'deleteJob') {
        // Execute delete command which will handle confirmation
        await vscode.commands.executeCommand('orchestrator.deleteJob', message.jobId);
        // Close the panel after successful deletion
        const jobStillExists = runner.list().find(j => j.id === message.jobId);
        if (!jobStillExists) {
          jobDetailPanels.delete(message.jobId);
          panel.dispose();
        }
      } else if (message.command === 'retryAttempt') {
        // For now, retry with the same job - could be enhanced to retry specific attempt
        await vscode.commands.executeCommand('orchestrator.retryJob', message.jobId);
      } else if (message.command === 'getProcessStats') {
        // Use cached global process stats if available and recent
        const now = Date.now();
        if (now - lastProcessStatsRefresh > PROCESS_STATS_CACHE_MS || globalProcessStatsCache.length === 0) {
          // Refresh cache if stale or empty
          globalProcessStatsCache = await getGlobalProcessStats();
          lastProcessStatsRefresh = now;
        }
        
        // Build tree for this job's specific PIDs from the global snapshot
        const currentJob = runner.list().find(j => j.id === jobId);
        if (currentJob && currentJob.processIds && currentJob.processIds.length > 0) {
          const stats = buildProcessTreeFromSnapshot(currentJob.processIds, globalProcessStatsCache);
          // Only send if we got results, otherwise keep the previous display
          if (stats && stats.length > 0) {
            panel.webview.postMessage({ command: 'updateProcessStats', stats });
          }
        }
      }
    });
    
    // Set initial HTML
    panel.webview.html = getJobDetailsHtml(job, panel.webview);
    
    // Auto-update if job is running OR just completed (to ensure final state shows)
    if (job.status === 'running' || job.status === 'queued') {
      const currentJobId = jobId as string; // Capture for closure (jobId is guaranteed non-null here)
      let completionUpdates = 0;
      const refreshTimer = setInterval(() => {
        const currentJob = runner.list().find(j => j.id === currentJobId);
        
        // If job completed, do one final update then stop after 2 cycles
        if (currentJob && (currentJob.status !== 'running' && currentJob.status !== 'queued')) {
          completionUpdates++;
          if (jobDetailPanels.has(currentJobId)) {
            jobDetailPanels.get(currentJobId)!.webview.html = getJobDetailsHtml(currentJob, panel.webview);
          }
          if (completionUpdates >= 2) {
            clearInterval(refreshTimer);
          }
          return;
        }
        
        if (!currentJob) {
          clearInterval(refreshTimer);
          return;
        }
        
        // Update panel if still open
        if (jobDetailPanels.has(currentJobId)) {
          jobDetailPanels.get(currentJobId)!.webview.html = getJobDetailsHtml(currentJob, panel.webview);
        }
      }, 2000);
    }
    
    return;
  }));
  
  // Helper function to get global process stats snapshot (all processes, once)
  async function getGlobalProcessStats(): Promise<any[]> {
    // Only collect if job detail panels are open
    if (jobDetailPanels.size === 0) {
      return [];
    }
    
    const { execSync } = require('child_process');
    
    try {
      if (process.platform === 'win32') {
        // Windows: Combine both CIM queries in a single PowerShell call for efficiency
        // Include additional properties: CreationDate, ThreadCount, HandleCount, Priority, ExecutablePath
        const combinedOutput = execSync(
          `powershell -NoProfile -Command "$procs = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,CreationDate,ThreadCount,HandleCount,Priority,ExecutablePath; $perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Select-Object IDProcess,PercentProcessorTime; $cpuMap = @{}; foreach ($p in $perf) { if ($p.IDProcess) { $cpuMap[$p.IDProcess] = $p.PercentProcessorTime } }; $result = @(); foreach ($proc in $procs) { $result += @{ ProcessId = $proc.ProcessId; ParentProcessId = $proc.ParentProcessId; Name = $proc.Name; CommandLine = $proc.CommandLine; WorkingSetSize = $proc.WorkingSetSize; CPU = if ($cpuMap.ContainsKey($proc.ProcessId)) { $cpuMap[$proc.ProcessId] } else { 0 }; CreationDate = if ($proc.CreationDate) { $proc.CreationDate.ToString('o') } else { $null }; ThreadCount = $proc.ThreadCount; HandleCount = $proc.HandleCount; Priority = $proc.Priority; ExecutablePath = $proc.ExecutablePath } }; $result | ConvertTo-Json"`,
          { encoding: 'utf-8', timeout: 5000 }
        );
        const procArray = JSON.parse(combinedOutput);
        const processes = Array.isArray(procArray) ? procArray : [procArray];
        
        // Get CPU core count for normalization
        const coreCount = require('os').cpus().length || 1;
        
        // Build process list from combined data
        const processList: any[] = [];
        for (const proc of processes) {
          if (proc && proc.ProcessId) {
            // Normalize CPU percentage (WMI returns total across all cores)
            const rawCpu = parseFloat(proc.CPU) || 0;
            const normalizedCpu = Math.min(rawCpu / coreCount, 100);
            
            processList.push({
              pid: proc.ProcessId,
              name: proc.Name || 'unknown',
              commandLine: proc.CommandLine || '',
              cpu: parseFloat(normalizedCpu.toFixed(1)),
              memory: parseInt(proc.WorkingSetSize) || 0,
              parentPid: proc.ParentProcessId,
              creationDate: proc.CreationDate || null,
              threadCount: proc.ThreadCount || 0,
              handleCount: proc.HandleCount || 0,
              priority: proc.Priority || 0,
              executablePath: proc.ExecutablePath || ''
            });
          }
        }
        
        return processList;
      } else {
        // Unix: Get all processes
        const allProcsOutput = execSync(
          `ps -eo pid,ppid,%cpu,rss,comm,args 2>/dev/null || true`,
          { encoding: 'utf-8', timeout: 3000 }
        ).trim();
        
        const lines = allProcsOutput.split('\n').slice(1); // Skip header
        const processList: any[] = [];
        
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 6) {
            const pid = parseInt(parts[0]);
            const name = parts[4] || 'unknown';
            const commandLine = parts.slice(5).join(' ') || '';
            processList.push({
              pid: pid,
              parentPid: parseInt(parts[1]),
              cpu: parseFloat(parts[2]) || 0,
              memory: (parseInt(parts[3]) || 0) * 1024,
              name: name,
              commandLine: commandLine
            });
          }
        }
        
        return processList;
      }
    } catch (e) {
      console.error('Failed to get process stats:', e);
      return [];
    }
  }
  
  // Helper function to build process tree for specific PIDs from global snapshot
  function buildProcessTreeFromSnapshot(pids: number[], processSnapshot: any[]): any[] {
    if (!pids || pids.length === 0 || !processSnapshot || processSnapshot.length === 0) {
      return [];
    }
    
    // Build process map from snapshot
    const processMap = new Map();
    for (const proc of processSnapshot) {
      processMap.set(proc.pid, proc);
    }
    
    // First, collect all PIDs that are legitimate descendants of our root PIDs
    // This prevents PID reuse issues where an old process has a parentPid 
    // that coincidentally matches one of our current process PIDs
    const legitimateDescendants = new Set<number>(pids); // Start with root PIDs
    
    // BFS to find all legitimate children - only add a child if its parent is already in our set
    let foundNew = true;
    let iterations = 0;
    const maxIterations = 20; // Prevent infinite loops
    
    while (foundNew && iterations < maxIterations) {
      foundNew = false;
      iterations++;
      
      for (const [childPid, childProc] of processMap.entries()) {
        // Only add this process as a child if:
        // 1. It's not already in our set
        // 2. Its parent IS in our set (meaning it's a legitimate descendant)
        // 3. It's not its own parent
        if (!legitimateDescendants.has(childPid) && 
            legitimateDescendants.has(childProc.parentPid) && 
            childPid !== childProc.parentPid) {
          legitimateDescendants.add(childPid);
          foundNew = true;
        }
      }
    }
    
    // Now build the tree, but only include processes in our legitimate set
    function buildTree(pid: number, depth: number = 0): any {
      const proc = processMap.get(pid);
      if (!proc || depth > 10) return null;
      
      const children: any[] = [];
      for (const [childPid, childProc] of processMap.entries()) {
        // Only include if it's a legitimate descendant AND its parent is this process
        if (legitimateDescendants.has(childPid) && 
            childProc.parentPid === pid && 
            childPid !== pid) {
          const childTree = buildTree(childPid, depth + 1);
          if (childTree) {
            children.push(childTree);
          }
        }
      }
      
      return {
        ...proc,
        children: children.length > 0 ? children : undefined
      };
    }
    
    // Build tree for each root PID
    const results: any[] = [];
    for (const rootPid of pids) {
      const tree = buildTree(rootPid);
      if (tree) {
        results.push(tree);
      }
    }
    
    return results;
  }
  
  // Old getProcessStats function - kept for reference but no longer used
  async function getProcessStats(pids: number[]): Promise<Array<{pid: number, cpu: number, memory: number, name: string, parentPid?: number, children?: Array<{pid: number, cpu: number, memory: number, name: string}>}>> {
    if (!pids || pids.length === 0) return [];
    
    const { execSync } = require('child_process');
    const results: Array<{pid: number, cpu: number, memory: number, name: string, parentPid?: number, children?: Array<{pid: number, cpu: number, memory: number, name: string}>}> = [];
    
    try {
      if (process.platform === 'win32') {
        // Windows: Get ALL processes efficiently by querying once and joining in memory
        // This is MUCH faster than querying CIM for each process individually
        
        // Get all CIM process data in one query
        const cimOutput = execSync(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json"`,
          { encoding: 'utf-8', timeout: 5000 }
        );
        const cimProcs = JSON.parse(cimOutput);
        const cimArray = Array.isArray(cimProcs) ? cimProcs : [cimProcs];
        
        // Build CIM data map
        const cimMap = new Map();
        for (const proc of cimArray) {
          if (proc && proc.ProcessId) {
            cimMap.set(proc.ProcessId, {
              parentPid: proc.ParentProcessId,
              commandLine: proc.CommandLine || ''
            });
          }
        }
        
        // Get all process performance data in one query
        const perfOutput = execSync(
          `powershell -NoProfile -Command "Get-Process | Select-Object Id,ProcessName,CPU,WorkingSet64 | ConvertTo-Json"`,
          { encoding: 'utf-8', timeout: 5000 }
        );
        const perfProcs = JSON.parse(perfOutput);
        const procArray = Array.isArray(perfProcs) ? perfProcs : [perfProcs];
        
        // Get CPU core count for percentage calculation
        const coreCount = require('os').cpus().length;
        
        // Build process map by joining CIM and performance data
        const processMap = new Map();
        for (const proc of procArray) {
          if (proc && proc.Id) {
            const cimData = cimMap.get(proc.Id);
            // CPU from Get-Process is total seconds used - convert to rough percentage
            // Note: This is cumulative, so active processes will show higher values
            const cpuTime = parseFloat(proc.CPU) || 0;
            const cpuPercent = cpuTime > 0 ? Math.min((cpuTime / 10) * 100 / coreCount, 100) : 0; // Rough estimate
            
            processMap.set(proc.Id, {
              pid: proc.Id,
              name: proc.ProcessName || 'unknown',
              commandLine: cimData?.commandLine || '',
              cpu: parseFloat(cpuPercent.toFixed(1)),
              memory: parseInt(proc.WorkingSet64) || 0,
              parentPid: cimData?.parentPid
            });
          }
        }
        
        // Recursive function to build tree for a given PID
        function buildTree(pid: number, depth: number = 0): any {
          const proc = processMap.get(pid);
          if (!proc || depth > 10) return null; // Limit recursion depth
          
          const children: any[] = [];
          for (const [childPid, childProc] of processMap.entries()) {
            if (childProc.parentPid === pid && childPid !== pid) {
              const childTree = buildTree(childPid, depth + 1);
              if (childTree) {
                children.push(childTree);
              }
            }
          }
          
          return {
            ...proc,
            children: children.length > 0 ? children : undefined
          };
        }
        
        // Build tree for each root PID
        for (const rootPid of pids) {
          const tree = buildTree(rootPid);
          if (tree) {
            results.push(tree);
          }
        }
      } else {
        // Unix: Get all processes and build tree recursively
        try {
          const allProcsOutput = execSync(
            `ps -eo pid,ppid,%cpu,rss,comm,args 2>/dev/null || true`,
            { encoding: 'utf-8', timeout: 3000 }
          ).trim();
          
          const lines = allProcsOutput.split('\n').slice(1); // Skip header
          const processMap = new Map();
          
          for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 6) {
              const pid = parseInt(parts[0]);
              const name = parts[4] || 'unknown';
              const commandLine = parts.slice(5).join(' ') || '';
              processMap.set(pid, {
                pid: pid,
                parentPid: parseInt(parts[1]),
                cpu: parseFloat(parts[2]) || 0,
                memory: (parseInt(parts[3]) || 0) * 1024,
                name: name,
                commandLine: commandLine
              });
            }
          }
          
          // Recursive function to build tree
          function buildTree(pid: number, depth: number = 0): any {
            const proc = processMap.get(pid);
            if (!proc || depth > 10) return null;
            
            const children: any[] = [];
            for (const [childPid, childProc] of processMap.entries()) {
              if (childProc.parentPid === pid && childPid !== pid) {
                const childTree = buildTree(childPid, depth + 1);
                if (childTree) {
                  children.push(childTree);
                }
              }
            }
            
            return {
              ...proc,
              children: children.length > 0 ? children : undefined
            };
          }
          
          // Build tree for each root PID
          for (const rootPid of pids) {
            const tree = buildTree(rootPid);
            if (tree) {
              results.push(tree);
            }
          }
        } catch (e) {
          // Fallback: try individual process queries
          for (const pid of pids) {
            try {
              // Get main process
              const output = execSync(
                `ps -p ${pid} -o pid=,ppid=,%cpu=,rss=,comm= 2>/dev/null || true`,
                { encoding: 'utf-8', timeout: 1000 }
              ).trim();
              
              if (output) {
                const parts = output.split(/\s+/);
                const mainProc = {
                  pid: parseInt(parts[0]),
                  parentPid: parseInt(parts[1]),
                  cpu: parseFloat(parts[2]) || 0,
                  memory: (parseInt(parts[3]) || 0) * 1024,
                  name: parts.slice(4).join(' ') || 'unknown'
                };
                
                // Get child processes
                const childOutput = execSync(
                  `ps --ppid ${pid} -o pid=,%cpu=,rss=,comm= 2>/dev/null || true`,
                  { encoding: 'utf-8', timeout: 1000 }
                ).trim();
                
                const children: any[] = [];
                if (childOutput) {
                  childOutput.split('\n').forEach((line: string) => {
                    const cparts = line.trim().split(/\s+/);
                    if (cparts.length >= 4) {
                      children.push({
                        pid: parseInt(cparts[0]),
                        cpu: parseFloat(cparts[1]) || 0,
                        memory: (parseInt(cparts[2]) || 0) * 1024,
                        name: cparts.slice(3).join(' ') || 'unknown'
                      });
                    }
                  });
                }
                
                results.push({ ...mainProc, children: children.length > 0 ? children : undefined });
              }
            } catch (e) {
              // Process might have exited, skip it
            }
          }
        }
      }
    } catch (e) {
      // Top-level error handler
      console.error('Failed to get process stats:', e);
    }
    
    return results;
  }
  
  // Helper function to generate job details HTML
  function getJobDetailsHtml(job: any, webview: vscode.Webview): string {
    const fs = require('fs');
    const path = require('path');
    
    // Reconcile inconsistent states (e.g., job failed but attempt still shows running)
    if (job.attempts && job.attempts.length > 0) {
      for (const attempt of job.attempts) {
        // If job is not running but attempt says running, fix it
        if (attempt.status === 'running' && job.status !== 'running' && job.status !== 'queued') {
          attempt.status = job.status === 'succeeded' ? 'succeeded' : 'failed';
          attempt.endedAt = attempt.endedAt || job.endedAt || Date.now();
        }
      }
    }
    
    function escapeHtml(text: string) {
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    
    // Build work history timeline (only if 2+ iterations exist)
    let workHistoryHtml = '';
    if (job.workHistory && job.workHistory.length >= 2) {
      const historyItems = job.workHistory.map((work: string, idx: number) => {
        const isLatest = idx === 0; // Latest is at index 0 (unshift)
        const isOriginal = idx === job.workHistory.length - 1; // Original is at end
        const label = isLatest ? 'Latest' : isOriginal ? 'Original' : `Iteration ${job.workHistory.length - idx - 1}`;
        const preview = work.length > 120 ? work.substring(0, 120) + '...' : work;
        const active = isLatest ? 'active' : '';
        
        return `
          <div class="work-history-item ${active}">
            <div class="work-history-dot"></div>
            <div class="work-history-content">
              <div class="work-history-label">${label}</div>
              <div class="work-history-preview">${escapeHtml(preview)}</div>
            </div>
          </div>
        `;
      }).join('');
      
      workHistoryHtml = `
        <div class="work-history-section">
          <h3>Work History</h3>
          <div class="work-history-timeline">
            ${historyItems}
          </div>
        </div>
      `;
    }
    
    // Build execution attempts as expandable cards
    let attemptsHtml = '';
    if (job.attempts && job.attempts.length > 0) {
      attemptsHtml = job.attempts.map((attempt: any, idx: number) => {
        const attemptNum = idx + 1;
        const isLatest = idx === job.attempts.length - 1;
        const duration = attempt.endedAt 
          ? Math.round((attempt.endedAt - attempt.startedAt) / 1000) + 's'
          : 'running...';
        const timestamp = new Date(attempt.startedAt).toLocaleString();
        
        // Step indicators (5 dots: prechecks, work, postchecks, mergeback, cleanup)
        const getStepDot = (status: string) => {
          if (status === 'success') return '<span class="step-dot success">●</span>';
          if (status === 'failed') return '<span class="step-dot failed">●</span>';
          if (status === 'skipped') return '<span class="step-dot skipped">●</span>';
          if (status === 'running') return '<span class="step-dot running">●</span>';
          return '<span class="step-dot pending">●</span>';
        };
        
        // Determine current step status (running if it's the current step and attempt is running)
        const getStepStatus = (stepName: string, stepStatus?: string) => {
          if (stepStatus) return stepStatus;
          if (attempt.status === 'running' && job.currentStep === stepName) return 'running';
          return 'pending';
        };
        
        const stepIndicators = `
          ${getStepDot(getStepStatus('prechecks', attempt.stepStatuses?.prechecks))}
          ${getStepDot(getStepStatus('work', attempt.stepStatuses?.work))}
          ${getStepDot(getStepStatus('postchecks', attempt.stepStatuses?.postchecks))}
          ${getStepDot(getStepStatus('mergeback', attempt.stepStatuses?.mergeback))}
          ${getStepDot(getStepStatus('cleanup', attempt.stepStatuses?.cleanup))}
        `;
        
        // Session ID with copy functionality
        const sessionIdHtml = attempt.copilotSessionId 
          ? `<strong>Session:</strong> <span class="session-id" data-session="${attempt.copilotSessionId}" title="Click to copy">${attempt.copilotSessionId.substring(0, 12)}... 📋</span>`
          : '';
        
        return `
          <div class="attempt-card ${attempt.attemptId === job.currentAttemptId ? 'active' : ''}" data-attempt-id="${attempt.attemptId}">
            <div class="attempt-header" data-expanded="${isLatest}">
              <div class="attempt-header-left">
                <span class="attempt-badge">#${attemptNum}</span>
                <span class="step-indicators">${stepIndicators}</span>
                <span class="attempt-time">${timestamp}</span>
                <span class="attempt-duration">(${duration})</span>
              </div>
              <span class="chevron">${isLatest ? '▼' : '▶'}</span>
            </div>
            <div class="attempt-body" style="display: ${isLatest ? 'block' : 'none'};">
              <div class="attempt-meta">
                <div class="attempt-meta-row"><strong>Status:</strong> <span class="status-${attempt.status}">${attempt.status}</span></div>
                <div class="attempt-meta-row"><strong>Attempt ID:</strong> <span class="attempt-id-value">${attempt.attemptId}</span></div>
                ${sessionIdHtml ? '<div class="attempt-meta-row">' + sessionIdHtml + '</div>' : ''}
                ${(attempt as any).workSummary ? `
                <div class="work-summary-box">
                  <span class="work-summary-icon">📊</span>
                  <strong>Work Summary:</strong> ${(attempt as any).workSummary.description}
                  <span class="work-summary-details">(${(attempt as any).workSummary.commits} commits, +${(attempt as any).workSummary.filesAdded} −${(attempt as any).workSummary.filesDeleted} ~${(attempt as any).workSummary.filesModified})</span>
                </div>
                ` : ''}
                <div class="attempt-meta-row"><strong>Task:</strong></div>
                <div class="work-instruction-box">${escapeHtml(job.task)}</div>
                <div class="attempt-meta-row"><strong>Work Instruction:</strong></div>
                <div class="work-instruction-box">${escapeHtml(attempt.workInstruction || job.policy.steps.work)}</div>
              </div>
              ${attempt.status === 'running' || (attempt.attemptId === job.currentAttemptId && (job.status === 'running' || job.status === 'queued')) ? `
              <div class="process-tree-section">
                <div class="process-tree-header" data-expanded="false">
                  <span class="process-tree-chevron">▶</span>
                  <span class="process-tree-icon">⚡</span>
                  <span class="process-tree-title">Running Processes</span>
                </div>
                <div class="process-tree" data-attempt-id="${attempt.attemptId}" style="display: none;">
                  <div class="loading">Loading process tree...</div>
                </div>
              </div>
              ` : ''}
              ${(() => {
                // Generate unified phase tabs - merged Phase Status + Log Tabs
                const ss = (job.status === 'running' || job.status === 'queued') ? (job.stepStatuses || {}) : (attempt.stepStatuses || {});
                const cs = job.currentStep;
                const isRunning = attempt.status === 'running';
                
                const getPhaseClass = (phase: string) => {
                  const status = ss[phase as keyof typeof ss];
                  if (status) return status;
                  if (isRunning && cs === phase) return 'running';
                  return 'pending';
                };
                
                const getPhaseIcon = (phase: string) => {
                  const status = ss[phase as keyof typeof ss];
                  if (status === 'success') return '✓';
                  if (status === 'failed') return '✗';
                  if (status === 'skipped') return '⊘';
                  if (isRunning && cs === phase) return '⟳';
                  return '○';
                };
                
                const phases = ['PRECHECKS', 'WORK', 'POSTCHECKS', 'MERGEBACK', 'CLEANUP'];
                const phaseTabs = phases.map(phase => {
                  const phaseLower = phase.toLowerCase();
                  const phaseClass = getPhaseClass(phaseLower);
                  const phaseIcon = getPhaseIcon(phaseLower);
                  const displayName = phase === 'PRECHECKS' ? 'Prechecks' : 
                                     phase === 'POSTCHECKS' ? 'Postchecks' : 
                                     phase === 'MERGEBACK' ? 'Mergeback' : 
                                     phase.charAt(0) + phase.slice(1).toLowerCase();
                  return `<button class="log-tab phase-tab phase-tab-${phaseClass}" data-section="${phase}"><span class="phase-icon phase-icon-${phaseClass}">${phaseIcon}</span>${displayName}</button>`;
                }).join('');
                
                return `<div class="log-tabs folder-tabs">
                  <button class="log-tab active" data-section="FULL">📋 Full</button>
                  ${phaseTabs}
                </div>`;
              })()}
              <div class="log-viewer" data-log="${attempt.logFile}" data-section="FULL" data-running="${attempt.status === 'running'}">
                ${attempt.logFile && fs.existsSync(attempt.logFile) ? '<div class="loading">Loading log...</div>' : '<div class="no-log">No log file available</div>'}
              </div>
            </div>
          </div>
        `;
      }).reverse().join('');
    }
    
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { 
      font: 12px sans-serif; 
      padding: 16px; 
      margin: 0; 
      color: var(--vscode-foreground); 
      background: var(--vscode-editor-background);
    }
    
    h2 { margin: 0 0 8px 0; }
    h3 { 
      font-size: 11px; 
      margin: 24px 0 12px 0; 
      text-transform: uppercase; 
      letter-spacing: 1px; 
      opacity: 0.6; 
      font-weight: 600;
    }
    
    /* Header */
    .header { 
      margin-bottom: 20px; 
      padding-bottom: 16px; 
      border-bottom: 2px solid var(--vscode-panel-border); 
    }
    .header-top { 
      display: flex; 
      justify-content: space-between; 
      align-items: center; 
      margin-bottom: 12px;
    }
    .title-section { flex: 1; }
    .action-buttons { 
      display: flex; 
      gap: 8px; 
    }
    .action-btn { 
      padding: 6px 14px; 
      border: none; 
      border-radius: 4px; 
      cursor: pointer; 
      font-size: 11px; 
      font-weight: 600; 
      transition: all 0.2s;
    }
    .action-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 2px 4px rgba(0,0,0,0.2);
    }
    .cancel-btn { 
      background: var(--vscode-button-background); 
      color: var(--vscode-button-foreground); 
    }
    .cancel-btn:hover:not(:disabled) { 
      background: var(--vscode-button-hoverBackground); 
    }
    .retry-btn { 
      background: var(--vscode-button-background); 
      color: var(--vscode-button-foreground); 
    }
    .retry-btn:hover:not(:disabled) { 
      background: var(--vscode-button-hoverBackground); 
    }
    .action-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none !important;
      box-shadow: none !important;
    }
    .delete-btn { 
      background: var(--vscode-button-secondaryBackground); 
      color: var(--vscode-button-secondaryForeground); 
    }
    .delete-btn:hover { 
      background: var(--vscode-button-secondaryHoverBackground); 
    }
    .status-badge { 
      padding: 4px 10px; 
      border-radius: 3px; 
      font-size: 11px; 
      font-weight: 600; 
      text-transform: uppercase; 
      margin-left: 12px;
      display: inline-flex;
      align-items: center;
    }
    .status-running { background: rgba(75, 166, 251, 0.2); border-left: 3px solid var(--vscode-progressBar-background, #4BA6FB); color: #7DD3FC; }
    .status-succeeded { background: rgba(78, 201, 176, 0.15); border-left: 3px solid var(--vscode-testing-iconPassed, #4EC9B0); color: var(--vscode-testing-iconPassed, #4EC9B0); }
    .status-failed { background: rgba(244, 135, 113, 0.15); border-left: 3px solid var(--vscode-testing-iconFailed, #F48771); color: var(--vscode-testing-iconFailed, #F48771); }
    .status-queued { background: rgba(133, 133, 133, 0.1); border-left: 3px solid var(--vscode-descriptionForeground, #858585); color: var(--vscode-descriptionForeground, #858585); }
    .status-canceled { background: rgba(133, 133, 133, 0.1); border-left: 3px solid var(--vscode-descriptionForeground, #858585); color: var(--vscode-descriptionForeground, #858585); }
    
    .live-duration, .duration-display {
      margin-left: 12px;
      font-size: 11px;
      opacity: 0.7;
      font-weight: 400;
    }
    
    /* Work History Timeline */
    .work-history-section { margin-bottom: 24px; }
    .work-history-timeline { 
      border-left: 2px solid var(--vscode-panel-border);
      padding-left: 0;
      margin-left: 12px;
    }
    .work-history-item {
      position: relative;
      padding-left: 24px;
      padding-bottom: 16px;
    }
    .work-history-item:last-child { padding-bottom: 0; }
    .work-history-dot {
      position: absolute;
      left: -7px;
      top: 6px;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--vscode-descriptionForeground);
      border: 2px solid var(--vscode-editor-background);
    }
    .work-history-item.active .work-history-dot {
      background: var(--vscode-progressBar-background);
      box-shadow: 0 0 0 3px rgba(0, 122, 204, 0.2);
    }
    .work-history-label {
      font-weight: 600;
      font-size: 11px;
      margin-bottom: 4px;
      color: var(--vscode-foreground);
    }
    .work-history-item.active .work-history-label {
      color: var(--vscode-progressBar-background);
    }
    .work-history-preview {
      font-size: 10px;
      opacity: 0.7;
      line-height: 1.4;
    }
    
    /* Execution Attempts */
    .attempt-card { 
      background: var(--vscode-sideBar-background); 
      border: 1px solid var(--vscode-panel-border); 
      border-radius: 6px; 
      margin-bottom: 12px; 
      overflow: hidden;
    }
    .attempt-card.active { 
      border-color: var(--vscode-progressBar-background); 
      border-width: 2px;
    }
    .attempt-header { 
      display: flex; 
      justify-content: space-between; 
      align-items: center; 
      padding: 10px 14px; 
      cursor: pointer;
      user-select: none;
    }
    .attempt-header:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .attempt-header-left { 
      display: flex; 
      gap: 12px; 
      align-items: center;
      flex: 1;
    }
    .attempt-badge { 
      font-weight: 700; 
      padding: 3px 8px; 
      background: var(--vscode-badge-background); 
      color: var(--vscode-badge-foreground); 
      border-radius: 4px; 
      font-size: 10px;
      min-width: 20px;
      text-align: center;
    }
    .step-indicators {
      display: flex;
      gap: 4px;
    }
    .step-dot {
      font-size: 14px;
    }
    .step-dot.success { color: var(--vscode-testing-iconPassed); }
    .step-dot.failed { color: var(--vscode-errorForeground); }
    .step-dot.skipped { color: #808080; }
    .step-dot.pending { color: var(--vscode-descriptionForeground); opacity: 0.5; }
    .step-dot.running { color: #7DD3FC; animation: pulse-dot 1.5s ease-in-out infinite; }
    @keyframes pulse-dot {
      0%, 100% { opacity: 0.4; transform: scale(1); }
      50% { opacity: 1; transform: scale(1.2); }
    }
    .attempt-time { 
      font-size: 10px; 
      opacity: 0.7; 
    }
    .attempt-duration { 
      font-size: 10px; 
      opacity: 0.7; 
    }
    .chevron {
      font-size: 12px;
      transition: transform 0.2s;
    }
    .chevron.expanded {
      transform: rotate(90deg);
    }
    
    /* Attempt Body */
    .attempt-body { 
      padding: 14px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }
    .attempt-meta { 
      font-size: 11px; 
      margin-bottom: 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .attempt-meta-row { 
      line-height: 1.6;
    }
    .attempt-meta-row strong {
      opacity: 0.7;
      font-weight: 600;
      margin-right: 8px;
    }
    .attempt-id-value {
      font-family: monospace;
      opacity: 0.8;
      font-size: 10px;
    }
    .work-summary-box {
      background: rgba(78, 201, 176, 0.1);
      border-left: 3px solid #4EC9B0;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 11px;
      margin: 8px 0;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .work-summary-icon {
      font-size: 14px;
    }
    .work-summary-details {
      opacity: 0.7;
      font-family: monospace;
      font-size: 10px;
    }
    .work-instruction-box {
      background: var(--vscode-textCodeBlock-background);
      padding: 10px;
      border-radius: 4px;
      font-size: 10px;
      max-height: 150px;
      overflow-y: auto;
      line-height: 1.5;
      white-space: pre-wrap;
      word-wrap: break-word;
      border: 1px solid var(--vscode-panel-border);
      margin-top: 4px;
    }
    .session-id {
      cursor: pointer;
      color: var(--vscode-textLink-foreground);
      text-decoration: underline;
      font-family: monospace;
    }
    .session-id:hover {
      opacity: 0.8;
    }
    
    /* Phase Summary */
    .phase-summary {
      background: var(--vscode-editor-background);
      padding: 8px 12px;
      margin: 8px 0;
      border-radius: 4px;
      border: 1px solid var(--vscode-panel-border);
      display: flex;
      gap: 8px;
      align-items: center;
      font-size: 11px;
      flex-wrap: wrap;
    }
    .phase-item {
      display: inline-flex;
      align-items: center;
      padding: 4px 8px;
      border-radius: 3px;
      font-weight: 500;
      font-size: 11px;
    }
    .phase-item.success {
      background: rgba(78, 201, 176, 0.15);
      border-left: 3px solid var(--vscode-testing-iconPassed, #4EC9B0);
    }
    .phase-item.failed {
      background: rgba(244, 135, 113, 0.15);
      border-left: 3px solid var(--vscode-testing-iconFailed, #F48771);
    }
    .phase-item.skipped {
      background: rgba(206, 145, 120, 0.15);
      border-left: 3px solid var(--vscode-editorWarning-foreground, #CE9178);
    }
    .phase-item.running {
      background: rgba(75, 166, 251, 0.15);
      border-left: 3px solid var(--vscode-progressBar-background, #4BA6FB);
    }
    .phase-item.pending {
      background: rgba(133, 133, 133, 0.1);
      border-left: 3px solid var(--vscode-descriptionForeground, #858585);
    }
    .phase-icon {
      margin-right: 4px;
      font-weight: bold;
      font-size: 12px;
    }
    .phase-icon-success {
      color: var(--vscode-testing-iconPassed, #4EC9B0);
    }
    .phase-icon-failed {
      color: var(--vscode-testing-iconFailed, #F48771);
    }
    .phase-icon-skipped {
      color: var(--vscode-editorWarning-foreground, #CE9178);
    }
    .phase-icon-running {
      color: var(--vscode-progressBar-background, #4BA6FB);
      animation: spin 2s linear infinite;
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .phase-icon-pending {
      color: var(--vscode-descriptionForeground, #858585);
      opacity: 0.7;
    }
    .phase-item.success {
      color: #4caf50;
    }
    .phase-item.failed {
      color: #f44336;
    }
    .phase-item.skipped {
      color: #ff9800;
    }
    .phase-item.pending {
      color: var(--vscode-descriptionForeground);
    }
    
    /* Unified Folder-Style Log/Phase Tabs */
    .log-tabs {
      display: flex;
      gap: 0;
      margin-bottom: 0;
      border-bottom: 2px solid var(--vscode-panel-border);
      flex-wrap: wrap;
    }
    .log-tabs.folder-tabs {
      padding-left: 4px;
    }
    .log-tab {
      padding: 8px 12px;
      background: var(--vscode-tab-inactiveBackground);
      border: 1px solid var(--vscode-panel-border);
      border-bottom: none;
      border-radius: 6px 6px 0 0;
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-foreground);
      opacity: 0.7;
      margin-right: -1px;
      margin-bottom: -2px;
      position: relative;
      transition: all 0.15s ease;
    }
    .log-tab:hover {
      opacity: 0.9;
      background: var(--vscode-tab-hoverBackground);
      z-index: 1;
    }
    .log-tab.active {
      opacity: 1;
      background: var(--vscode-tab-activeBackground);
      border-color: var(--vscode-panel-border);
      border-bottom: 2px solid var(--vscode-tab-activeBackground);
      z-index: 2;
    }
    /* Phase-specific tab colors */
    .log-tab.phase-tab-success {
      background: rgba(78, 201, 176, 0.1);
      border-left: 3px solid #4EC9B0;
    }
    .log-tab.phase-tab-success.active {
      background: rgba(78, 201, 176, 0.2);
    }
    .log-tab.phase-tab-failed {
      background: rgba(244, 135, 113, 0.1);
      border-left: 3px solid #F48771;
    }
    .log-tab.phase-tab-failed.active {
      background: rgba(244, 135, 113, 0.2);
    }
    .log-tab.phase-tab-skipped {
      background: rgba(206, 145, 120, 0.1);
      border-left: 3px solid #CE9178;
    }
    .log-tab.phase-tab-skipped.active {
      background: rgba(206, 145, 120, 0.2);
    }
    .log-tab.phase-tab-running {
      background: rgba(125, 211, 252, 0.1);
      border-left: 3px solid #7DD3FC;
      animation: pulse-tab 2s ease-in-out infinite;
    }
    .log-tab.phase-tab-running.active {
      background: rgba(125, 211, 252, 0.2);
    }
    .log-tab.phase-tab-pending {
      opacity: 0.5;
    }
    @keyframes pulse-tab {
      0%, 100% { opacity: 0.7; }
      50% { opacity: 1; }
    }
    
    /* Log Viewer */
    .log-viewer {
      background: var(--vscode-terminal-background);
      color: var(--vscode-terminal-foreground);
      padding: 12px;
      border-radius: 4px;
      font-family: monospace;
      font-size: 10px;
      max-height: 400px;
      overflow-y: auto;
      overflow-x: auto;
      line-height: 1.5;
      white-space: pre-wrap;
      word-wrap: break-word;
      outline: none;
    }
    .log-viewer:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    .log-viewer .loading {
      text-align: center;
      opacity: 0.6;
      padding: 20px;
    }
    .log-viewer .no-log {
      text-align: center;
      opacity: 0.6;
      padding: 20px;
    }
    
    .loading { 
      padding: 12px; 
      text-align: center; 
      opacity: 0.6; 
      font-size: 11px; 
    }
    
    /* Process Tree */
    .process-tree-section {
      margin: 16px 0;
      padding: 12px;
      background: var(--vscode-sideBar-background);
      border-radius: 6px;
      border: 1px solid var(--vscode-panel-border);
    }
    .process-tree-header {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      user-select: none;
    }
    .process-tree-header[data-expanded="true"] {
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .process-tree-header:hover {
      opacity: 0.8;
    }
    .process-tree-chevron {
      font-size: 10px;
      transition: transform 0.2s;
      opacity: 0.7;
    }
    .process-tree-header[data-expanded="true"] .process-tree-chevron {
      transform: rotate(90deg);
    }
    .process-tree-icon {
      font-size: 16px;
    }
    .process-tree-title {
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.8;
    }
    .process-tree {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 400px;
      overflow-y: auto;
    }
    .process-node {
      background: var(--vscode-editor-background);
      border-radius: 4px;
      padding: 8px 10px;
      border-left: 3px solid var(--vscode-progressBar-background);
      transition: all 0.2s;
    }
    .process-clickable {
      cursor: pointer;
    }
    .process-node:hover {
      background: var(--vscode-list-hoverBackground);
      transform: translateX(2px);
    }
    .process-child:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .process-node-main {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .process-node-left {
      display: flex;
      align-items: center;
      gap: 10px;
      flex: 1;
      min-width: 0;
    }
    .process-perf-icon {
      font-size: 16px;
      flex-shrink: 0;
    }
    .process-node-info {
      flex: 1;
      min-width: 0;
    }
    .process-node-name {
      font-weight: 600;
      font-size: 11px;
      color: var(--vscode-foreground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .process-node-pid {
      font-size: 9px;
      opacity: 0.6;
      font-family: monospace;
      margin-top: 2px;
    }
    .process-node-stats {
      display: flex;
      gap: 12px;
      flex-shrink: 0;
    }
    .process-stat {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
    }
    .process-stat-label {
      font-size: 8px;
      opacity: 0.5;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .process-stat-value {
      font-size: 11px;
      font-weight: 700;
      font-family: monospace;
      margin-top: 1px;
    }
    .process-stat-value.low { color: var(--vscode-testing-iconPassed); }
    .process-stat-value.medium { color: #FFA500; }
    .process-stat-value.high { color: var(--vscode-errorForeground); }
    
    /* Child processes */
    .process-children {
      margin-top: 6px;
      margin-left: 24px;
      padding-left: 12px;
      border-left: 2px dashed var(--vscode-panel-border);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .process-child {
      background: var(--vscode-sideBar-background);
      border-radius: 4px;
      padding: 6px 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      border-left: 2px solid var(--vscode-descriptionForeground);
      opacity: 0.95;
    }
    .process-child-main {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
    }
    .process-child:hover {
      background: var(--vscode-list-hoverBackground);
      opacity: 1;
    }
    .process-child-left {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 1;
      min-width: 0;
    }
    .process-child-arrow {
      font-size: 12px;
      opacity: 0.5;
    }
    .process-child-name {
      font-size: 10px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .process-child-pid {
      font-size: 8px;
      opacity: 0.5;
      font-family: monospace;
      margin-left: 6px;
    }
    .process-child-stats {
      display: flex;
      gap: 10px;
      flex-shrink: 0;
    }
    .process-cmdline {
      font-size: 9px;
      opacity: 0.5;
      font-family: monospace;
      margin-left: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 4ch;
      max-width: 100%;
    }
    .process-node-cmdline {
      font-size: 9px;
      opacity: 0.5;
      font-family: monospace;
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 4ch;
    }
    .process-child-cmdline {
      font-size: 8px;
      opacity: 0.5;
      font-family: monospace;
      margin-top: 2px;
      margin-left: 26px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    /* Process Details Modal */
    .process-modal-overlay {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.6);
      z-index: 1000;
      align-items: center;
      justify-content: center;
    }
    .process-modal-overlay.visible {
      display: flex;
    }
    .process-modal {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      min-width: 450px;
      max-width: 600px;
      max-height: 80vh;
      overflow: hidden;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    }
    .process-modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .process-modal-title {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 600;
      font-size: 14px;
    }
    .process-modal-close {
      background: none;
      border: none;
      color: var(--vscode-foreground);
      font-size: 18px;
      cursor: pointer;
      opacity: 0.7;
      padding: 4px 8px;
      border-radius: 4px;
    }
    .process-modal-close:hover {
      opacity: 1;
      background: var(--vscode-list-hoverBackground);
    }
    .process-modal-body {
      padding: 16px;
      overflow-y: auto;
      max-height: calc(80vh - 60px);
    }
    .process-detail-section {
      margin-bottom: 16px;
    }
    .process-detail-section:last-child {
      margin-bottom: 0;
    }
    .process-detail-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.6;
      margin-bottom: 4px;
    }
    .process-detail-value {
      font-size: 13px;
      font-family: monospace;
      background: var(--vscode-textCodeBlock-background);
      padding: 8px 10px;
      border-radius: 4px;
      word-break: break-all;
    }
    .process-detail-value.cmdline {
      font-size: 11px;
      white-space: pre-wrap;
      max-height: 150px;
      overflow-y: auto;
    }
    .process-stats-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
    }
    .process-stat-card {
      background: var(--vscode-textCodeBlock-background);
      padding: 12px;
      border-radius: 6px;
      text-align: center;
    }
    .process-stat-card-value {
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 4px;
    }
    .process-stat-card-value.cpu-high { color: #F48771; }
    .process-stat-card-value.cpu-medium { color: #CCA700; }
    .process-stat-card-value.mem-high { color: #F48771; }
    .process-stat-card-value.mem-medium { color: #CCA700; }
    .process-stat-card-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.6;
    }
    .process-stats-grid-4 {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
      margin-top: 12px;
    }
    .process-stat-card-small {
      background: var(--vscode-textCodeBlock-background);
      padding: 8px;
      border-radius: 4px;
      text-align: center;
    }
    .process-stat-card-small .process-stat-card-value {
      font-size: 16px;
    }
    .process-nav-link {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: underline;
    }
    .process-nav-link:hover {
      opacity: 0.8;
    }
    .process-nav-link.disabled {
      color: var(--vscode-descriptionForeground);
      cursor: default;
      text-decoration: none;
      opacity: 0.5;
    }
    .process-children-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 4px;
    }
    .process-child-link {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      cursor: pointer;
      font-family: monospace;
    }
    .process-child-link:hover {
      opacity: 0.8;
    }
  </style>
</head>
<body>
  <!-- Process Details Modal -->
  <div class="process-modal-overlay" id="processModal">
    <div class="process-modal">
      <div class="process-modal-header">
        <div class="process-modal-title">
          <span id="modalPerfIcon">🟢</span>
          <span id="modalProcessName">Process</span>
        </div>
        <button class="process-modal-close" id="closeProcessModal">✕</button>
      </div>
      <div class="process-modal-body">
        <div class="process-stats-grid">
          <div class="process-stat-card">
            <div class="process-stat-card-value" id="modalCpu">0%</div>
            <div class="process-stat-card-label">CPU Usage</div>
          </div>
          <div class="process-stat-card">
            <div class="process-stat-card-value" id="modalMemory">0 MB</div>
            <div class="process-stat-card-label">Memory</div>
          </div>
        </div>
        <div class="process-stats-grid-4">
          <div class="process-stat-card-small">
            <div class="process-stat-card-value" id="modalThreads">0</div>
            <div class="process-stat-card-label">Threads</div>
          </div>
          <div class="process-stat-card-small">
            <div class="process-stat-card-value" id="modalHandles">0</div>
            <div class="process-stat-card-label">Handles</div>
          </div>
          <div class="process-stat-card-small">
            <div class="process-stat-card-value" id="modalPriority">0</div>
            <div class="process-stat-card-label">Priority</div>
          </div>
          <div class="process-stat-card-small">
            <div class="process-stat-card-value" id="modalUptime">-</div>
            <div class="process-stat-card-label">Uptime</div>
          </div>
        </div>
        <div class="process-detail-section">
          <div class="process-detail-label">Process ID</div>
          <div class="process-detail-value" id="modalPid">-</div>
        </div>
        <div class="process-detail-section">
          <div class="process-detail-label">Parent Process</div>
          <div class="process-detail-value"><span id="modalParentPid" class="process-nav-link">-</span></div>
        </div>
        <div class="process-detail-section" id="modalChildrenSection" style="display:none;">
          <div class="process-detail-label">Child Processes</div>
          <div class="process-children-list" id="modalChildren"></div>
        </div>
        <div class="process-detail-section">
          <div class="process-detail-label">Executable Path</div>
          <div class="process-detail-value" id="modalExePath">-</div>
        </div>
        <div class="process-detail-section">
          <div class="process-detail-label">Command Line</div>
          <div class="process-detail-value cmdline" id="modalCmdline">-</div>
        </div>
        <div class="process-detail-section">
          <div class="process-detail-label">Started</div>
          <div class="process-detail-value" id="modalStarted">-</div>
        </div>
      </div>
    </div>
  </div>

  <div class="header">
    <div class="header-top">
      <div class="title-section">
        <h2>${escapeHtml(job.name)}<span class="status-badge status-${job.status}">${job.status}</span>${job.status === 'running' && job.startedAt ? '<span class="live-duration" data-started="' + job.startedAt + '"></span>' : (job.endedAt && job.startedAt ? '<span class="duration-display">' + Math.floor((job.endedAt - job.startedAt) / 1000) + 's</span>' : '')}</h2>
      </div>
    </div>
    <div class="action-buttons">
      ${job.status === 'running' || job.status === 'queued' ? '<button class="action-btn cancel-btn" data-action="cancel" data-job-id="' + job.id + '">⏹ Cancel</button>' : ''}
      ${job.status === 'failed' ? '<button class="action-btn retry-btn" data-action="retry" data-job-id="' + job.id + '">🔄 Retry with AI Analysis</button>' : ''}
      <button class="action-btn delete-btn" data-action="delete" data-job-id="${job.id}">🗑 Delete</button>
    </div>
  </div>
  
  ${workHistoryHtml}
  
  <h3>Execution Attempts</h3>
  ${attemptsHtml || '<div style="opacity:0.6;padding:20px;text-align:center">No execution attempts yet</div>'}
  
  <script>
    const vscode = acquireVsCodeApi();
    let currentJob = ${JSON.stringify(job)};
    
    // Format duration helper
    function formatDuration(seconds) {
      if (seconds < 60) return seconds + 's';
      if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
      const hours = Math.floor(seconds / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      return hours + 'h ' + mins + 'm';
    }
    
    // Update live duration for running job
    function updateLiveDuration() {
      const liveDur = document.querySelector('.live-duration');
      if (liveDur) {
        const startedAt = parseInt(liveDur.getAttribute('data-started'));
        if (startedAt) {
          const elapsed = Math.floor((Date.now() - startedAt) / 1000);
          liveDur.textContent = formatDuration(elapsed);
        }
      }
    }
    
    // Update every second if job is running
    if (currentJob.status === 'running') {
      updateLiveDuration();
      setInterval(updateLiveDuration, 1000);
    }
    
    // Handle attempt expand/collapse
    document.querySelectorAll('.attempt-header').forEach(header => {
      header.addEventListener('click', (e) => {
        const card = header.closest('.attempt-card');
        const body = card.querySelector('.attempt-body');
        const chevron = header.querySelector('.chevron');
        const isExpanded = header.getAttribute('data-expanded') === 'true';
        
        if (isExpanded) {
          body.style.display = 'none';
          chevron.textContent = '▶';
          header.setAttribute('data-expanded', 'false');
        } else {
          body.style.display = 'block';
          chevron.textContent = '▼';
          header.setAttribute('data-expanded', 'true');
          
          // Load log if not loaded yet
          const attemptId = card.getAttribute('data-attempt-id');
          const logViewer = body.querySelector('.log-viewer');
          if (logViewer && logViewer.textContent.includes('Loading log...')) {
            loadLog(logViewer);
          }
        }
      });
    });
    
    // Handle process tree expand/collapse
    document.querySelectorAll('.process-tree-header').forEach(header => {
      header.addEventListener('click', (e) => {
        const section = header.closest('.process-tree-section');
        const tree = section.querySelector('.process-tree');
        const chevron = header.querySelector('.process-tree-chevron');
        const isExpanded = header.getAttribute('data-expanded') === 'true';
        
        if (isExpanded) {
          tree.style.display = 'none';
          chevron.textContent = '▶';
          header.setAttribute('data-expanded', 'false');
        } else {
          tree.style.display = 'flex';
          chevron.textContent = '▼';
          header.setAttribute('data-expanded', 'true');
        }
      });
    });
    
    // Handle log tab clicks
    document.querySelectorAll('.log-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const tabs = tab.parentElement;
        const section = tab.getAttribute('data-section');
        const attemptBody = tab.closest('.attempt-body');
        const logViewer = attemptBody.querySelector('.log-viewer');
        
        // Update tab active state
        tabs.querySelectorAll('.log-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        
        // Update log viewer section
        logViewer.setAttribute('data-section', section);
        loadLog(logViewer);
      });
    });
    
    // Handle keyboard shortcuts in log viewer
    document.querySelectorAll('.log-viewer').forEach(logViewer => {
      logViewer.setAttribute('tabindex', '0'); // Make focusable
      logViewer.addEventListener('keydown', (e) => {
        // CTRL+A - select all text in log viewer
        if (e.ctrlKey && e.key === 'a') {
          e.preventDefault();
          e.stopPropagation();
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(logViewer);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        // ESC - deselect text
        if (e.key === 'Escape') {
          e.preventDefault();
          const selection = window.getSelection();
          selection.removeAllRanges();
        }
        // CTRL+C - copy selected text to clipboard
        if (e.ctrlKey && e.key === 'c') {
          const selection = window.getSelection();
          const selectedText = selection.toString();
          if (selectedText) {
            e.preventDefault();
            vscode.postMessage({ command: 'copyToClipboard', text: selectedText });
          }
        }
      });
      // Auto-focus log viewer when clicked to enable keyboard shortcuts
      logViewer.addEventListener('click', () => {
        logViewer.focus();
      });
    });
    
    // Handle session ID copy
    document.querySelectorAll('.session-id').forEach(el => {
      el.addEventListener('click', (e) => {
        const sessionId = el.getAttribute('data-session');
        vscode.postMessage({ command: 'copyToClipboard', text: sessionId });
      });
    });
    
    // Handle action button clicks
    document.querySelectorAll('.action-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        // Prevent double-clicks by checking if already disabled
        if (btn.disabled) return;
        
        const action = btn.getAttribute('data-action');
        const jobId = btn.getAttribute('data-job-id');
        
        // Disable button immediately to prevent multiple clicks
        btn.disabled = true;
        const originalText = btn.textContent;
        
        if (action === 'cancel') {
          btn.textContent = '⏳ Canceling...';
          vscode.postMessage({ command: 'cancelJob', jobId: jobId });
        } else if (action === 'retry') {
          btn.textContent = '⏳ Starting...';
          vscode.postMessage({ command: 'retryJob', jobId: jobId });
        } else if (action === 'delete') {
          btn.textContent = '⏳ Deleting...';
          vscode.postMessage({ command: 'deleteJob', jobId: jobId });
        }
      });
    });
    
    // Load log content into viewer
    function loadLog(logViewer) {
      const logPath = logViewer.getAttribute('data-log');
      const section = logViewer.getAttribute('data-section');
      const isRunning = logViewer.getAttribute('data-running') === 'true';
      
      if (!logPath) {
        logViewer.innerHTML = '<div class="no-log">No log file available</div>';
        return;
      }
      
      vscode.postMessage({ 
        command: 'getLogContent', 
        logPath: logPath, 
        section: section,
        isRunning: isRunning
      });
    }
    
    // Track which log viewers should auto-scroll (user hasn't scrolled away from bottom)
    const autoScrollEnabled = new WeakMap();
    
    // Initialize auto-scroll state and track user scroll behavior
    document.querySelectorAll('.log-viewer').forEach(viewer => {
      autoScrollEnabled.set(viewer, true); // Start with auto-scroll enabled
      
      viewer.addEventListener('scroll', () => {
        // Check if user is at the bottom (within 50px tolerance)
        const isAtBottom = viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < 50;
        autoScrollEnabled.set(viewer, isAtBottom);
      });
    });
    
    // Listen for log content updates
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.command === 'updateLogContent') {
        const logViewers = document.querySelectorAll('.log-viewer');
        logViewers.forEach(viewer => {
          if (viewer.getAttribute('data-log') === message.logPath &&
              viewer.getAttribute('data-section') === message.section) {
            
            // Check if we should auto-scroll BEFORE updating content
            const shouldAutoScroll = autoScrollEnabled.get(viewer) !== false;
            
            viewer.textContent = message.content || 'No log content';
            
            // Only auto-scroll if running AND user hasn't scrolled away
            if (viewer.getAttribute('data-running') === 'true' && shouldAutoScroll) {
              viewer.scrollTop = viewer.scrollHeight;
            }
          }
        });
      } else if (message.command === 'updateProcessStats') {
        renderProcessTree(message.stats);
      }
    });
    
    // Render beautiful process tree (recursive)
    let lastKnownStats = [];
    function renderProcessTree(stats) {
      if (!stats || stats.length === 0) {
        // Keep last known stats to prevent flashing
        if (lastKnownStats.length === 0) {
          document.querySelectorAll('.process-tree').forEach(tree => {
            tree.innerHTML = '<div class="loading">No active processes</div>';
          });
          // Clear header stats
          document.querySelectorAll('.process-tree-title').forEach(title => {
            title.textContent = 'Running Processes';
          });
        }
        return;
      }
      
      lastKnownStats = stats;
      
      // Calculate total count, CPU, and memory across entire tree
      function countProcesses(proc) {
        let count = 1; // Count this process
        if (proc.children && proc.children.length > 0) {
          proc.children.forEach(child => {
            count += countProcesses(child);
          });
        }
        return count;
      }
      
      function sumStats(proc) {
        let cpu = proc.cpu || 0;
        let memory = proc.memory || 0;
        if (proc.children && proc.children.length > 0) {
          proc.children.forEach(child => {
            const childStats = sumStats(child);
            cpu += childStats.cpu;
            memory += childStats.memory;
          });
        }
        return { cpu, memory };
      }
      
      const totalCount = stats.reduce((sum, proc) => sum + countProcesses(proc), 0);
      const totals = stats.reduce((acc, proc) => {
        const procTotals = sumStats(proc);
        return {
          cpu: acc.cpu + procTotals.cpu,
          memory: acc.memory + procTotals.memory
        };
      }, { cpu: 0, memory: 0 });
      
      const totalMemMB = (totals.memory / 1024 / 1024).toFixed(1);
      const totalCpuPercent = totals.cpu.toFixed(0);
      
      // Update header with stats
      document.querySelectorAll('.process-tree-title').forEach(title => {
        title.innerHTML = 'Running Processes <span style="opacity: 0.7; font-weight: normal;">(' + totalCount + ' processes • ' + totalCpuPercent + '% CPU • ' + totalMemMB + ' MB)</span>';
      });
      
      // Recursive function to render a process and its children
      function renderProcess(proc, depth = 0, parentPid = null) {
        const memMB = (proc.memory / 1024 / 1024).toFixed(1);
        const cpuPercent = (proc.cpu || 0).toFixed(0);
        
        // Performance indicators based on memory and CPU
        let perfIcon = '🟢';
        let memClass = 'low';
        let cpuClass = 'low';
        
        if (proc.memory > 500 * 1024 * 1024) {
          perfIcon = '🔴';
          memClass = 'high';
        } else if (proc.memory > 200 * 1024 * 1024) {
          perfIcon = '🟡';
          memClass = 'medium';
        }
        
        if (proc.cpu > 80) {
          cpuClass = 'high';
        } else if (proc.cpu > 30) {
          cpuClass = 'medium';
        }
        
        // Escape strings for data attributes
        const escapedCmdLine = (proc.commandLine || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const escapedExePath = (proc.executablePath || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const childPids = (proc.children || []).map(c => c.pid).join(',');
        
        const dataAttrs = 'data-pid="' + proc.pid + '" data-name="' + proc.name + '" data-cpu="' + cpuPercent + '" data-memory="' + memMB + '" data-cmdline="' + escapedCmdLine + '" data-parent-pid="' + (parentPid || proc.parentPid || '-') + '" data-perf-icon="' + perfIcon + '" data-threads="' + (proc.threadCount || 0) + '" data-handles="' + (proc.handleCount || 0) + '" data-priority="' + (proc.priority || 0) + '" data-created="' + (proc.creationDate || '') + '" data-exe-path="' + escapedExePath + '" data-children="' + childPids + '"';
        
        // Root process or child process styling
        if (depth === 0) {
          let html = '<div class="process-node process-clickable" ' + dataAttrs + '>' +
            '<div class="process-node-main">' +
              '<div class="process-node-left">' +
                '<span class="process-perf-icon">' + perfIcon + '</span>' +
                '<div class="process-node-info">' +
                  '<div class="process-node-name">' + proc.name + '</div>' +
                  '<div class="process-node-pid">PID ' + proc.pid + '</div>' +
                  (proc.commandLine ? '<div class="process-node-cmdline">' + proc.commandLine + '</div>' : '') +
                '</div>' +
              '</div>' +
              '<div class="process-node-stats">' +
                '<div class="process-stat">' +
                  '<div class="process-stat-label">CPU</div>' +
                  '<div class="process-stat-value ' + cpuClass + '">' + cpuPercent + '%</div>' +
                '</div>' +
                '<div class="process-stat">' +
                  '<div class="process-stat-label">Memory</div>' +
                  '<div class="process-stat-value ' + memClass + '">' + memMB + ' MB</div>' +
                '</div>' +
              '</div>' +
            '</div>';
          
          // Recursively render children
          if (proc.children && proc.children.length > 0) {
            html += '<div class="process-children">';
            proc.children.forEach(child => {
              html += renderProcess(child, depth + 1, proc.pid);
            });
            html += '</div>';
          }
          
          html += '</div>';
          return html;
        } else {
          // Child process with depth-based indentation
          const indent = depth * 20; // 20px per level
          let html = '<div class="process-child process-clickable" style="margin-left: ' + indent + 'px;" ' + dataAttrs + '>' +
            '<div class="process-child-main">' +
              '<div class="process-child-left">' +
                '<span class="process-perf-icon">' + perfIcon + '</span>' +
                '<span class="process-child-arrow">↳</span>' +
                '<span class="process-child-name">' + proc.name + '</span>' +
                '<span class="process-child-pid">PID ' + proc.pid + '</span>' +
              '</div>' +
              '<div class="process-child-stats">' +
                '<div class="process-stat">' +
                  '<div class="process-stat-label">CPU</div>' +
                  '<div class="process-stat-value ' + cpuClass + '">' + cpuPercent + '%</div>' +
                '</div>' +
                '<div class="process-stat">' +
                  '<div class="process-stat-label">Memory</div>' +
                  '<div class="process-stat-value ' + memClass + '">' + memMB + ' MB</div>' +
                '</div>' +
              '</div>' +
            '</div>' +
            (proc.commandLine ? '<div class="process-child-cmdline">' + proc.commandLine + '</div>' : '') +
          '</div>';
          
          // Recursively render grandchildren with increased depth
          if (proc.children && proc.children.length > 0) {
            proc.children.forEach(child => {
              html += renderProcess(child, depth + 1, proc.pid);
            });
          }
          
          return html;
        }
      }
      
      const html = stats.map(proc => renderProcess(proc)).join('');
      
      document.querySelectorAll('.process-tree').forEach(tree => {
        tree.innerHTML = html;
        
        // Attach click handlers for process details modal
        tree.querySelectorAll('.process-clickable').forEach(node => {
          node.addEventListener('click', (e) => {
            e.stopPropagation();
            showProcessModal(node);
          });
        });
      });
    }
    
    // Process details modal
    const processModal = document.getElementById('processModal');
    const closeModalBtn = document.getElementById('closeProcessModal');
    
    // Helper to find process node by PID
    function findProcessNodeByPid(pid) {
      return document.querySelector('.process-clickable[data-pid="' + pid + '"]');
    }
    
    // Helper to format uptime
    function formatUptime(creationDate) {
      if (!creationDate) return '-';
      try {
        const created = new Date(creationDate);
        const now = new Date();
        const diffMs = now - created;
        const diffSec = Math.floor(diffMs / 1000);
        if (diffSec < 60) return diffSec + 's';
        const diffMin = Math.floor(diffSec / 60);
        if (diffMin < 60) return diffMin + 'm ' + (diffSec % 60) + 's';
        const diffHour = Math.floor(diffMin / 60);
        if (diffHour < 24) return diffHour + 'h ' + (diffMin % 60) + 'm';
        const diffDays = Math.floor(diffHour / 24);
        return diffDays + 'd ' + (diffHour % 24) + 'h';
      } catch (e) {
        return '-';
      }
    }
    
    // Helper to format date
    function formatDate(dateStr) {
      if (!dateStr) return '-';
      try {
        const d = new Date(dateStr);
        return d.toLocaleString();
      } catch (e) {
        return '-';
      }
    }
    
    function showProcessModal(node) {
      const pid = node.getAttribute('data-pid');
      const name = node.getAttribute('data-name');
      const cpu = node.getAttribute('data-cpu');
      const memory = node.getAttribute('data-memory');
      const cmdline = node.getAttribute('data-cmdline') || '-';
      const parentPid = node.getAttribute('data-parent-pid') || '-';
      const perfIcon = node.getAttribute('data-perf-icon') || '🟢';
      const threads = node.getAttribute('data-threads') || '0';
      const handles = node.getAttribute('data-handles') || '0';
      const priority = node.getAttribute('data-priority') || '0';
      const creationDate = node.getAttribute('data-created') || '';
      const exePath = node.getAttribute('data-exe-path') || '-';
      const childPids = node.getAttribute('data-children') || '';
      
      document.getElementById('modalProcessName').textContent = name;
      document.getElementById('modalPerfIcon').textContent = perfIcon;
      document.getElementById('modalPid').textContent = pid;
      document.getElementById('modalCmdline').textContent = cmdline.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      document.getElementById('modalExePath').textContent = exePath.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      document.getElementById('modalStarted').textContent = formatDate(creationDate);
      
      // New stats
      document.getElementById('modalThreads').textContent = threads;
      document.getElementById('modalHandles').textContent = handles;
      document.getElementById('modalPriority').textContent = priority;
      document.getElementById('modalUptime').textContent = formatUptime(creationDate);
      
      // Parent process - make clickable if exists
      const parentEl = document.getElementById('modalParentPid');
      const parentNode = findProcessNodeByPid(parentPid);
      if (parentNode && parentPid !== '-') {
        parentEl.textContent = parentPid + ' (' + parentNode.getAttribute('data-name') + ')';
        parentEl.className = 'process-nav-link';
        parentEl.onclick = () => showProcessModal(parentNode);
      } else {
        parentEl.textContent = parentPid;
        parentEl.className = 'process-nav-link disabled';
        parentEl.onclick = null;
      }
      
      // Child processes - render as clickable badges
      const childrenSection = document.getElementById('modalChildrenSection');
      const childrenEl = document.getElementById('modalChildren');
      if (childPids) {
        const pids = childPids.split(',').filter(p => p);
        if (pids.length > 0) {
          childrenSection.style.display = 'block';
          childrenEl.innerHTML = pids.map(cpid => {
            const childNode = findProcessNodeByPid(cpid);
            const childName = childNode ? childNode.getAttribute('data-name') : 'unknown';
            return '<span class="process-child-link" data-nav-pid="' + cpid + '">' + cpid + ' (' + childName + ')</span>';
          }).join('');
          
          // Attach click handlers to child links
          childrenEl.querySelectorAll('.process-child-link').forEach(link => {
            link.addEventListener('click', () => {
              const navPid = link.getAttribute('data-nav-pid');
              const navNode = findProcessNodeByPid(navPid);
              if (navNode) showProcessModal(navNode);
            });
          });
        } else {
          childrenSection.style.display = 'none';
        }
      } else {
        childrenSection.style.display = 'none';
      }
      
      const cpuEl = document.getElementById('modalCpu');
      cpuEl.textContent = cpu + '%';
      cpuEl.className = 'process-stat-card-value' + (parseInt(cpu) > 80 ? ' cpu-high' : parseInt(cpu) > 30 ? ' cpu-medium' : '');
      
      const memEl = document.getElementById('modalMemory');
      memEl.textContent = memory + ' MB';
      memEl.className = 'process-stat-card-value' + (parseFloat(memory) > 500 ? ' mem-high' : parseFloat(memory) > 200 ? ' mem-medium' : '');
      
      processModal.classList.add('visible');
    }
    
    function hideProcessModal() {
      processModal.classList.remove('visible');
    }
    
    closeModalBtn.addEventListener('click', hideProcessModal);
    processModal.addEventListener('click', (e) => {
      if (e.target === processModal) {
        hideProcessModal();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && processModal.classList.contains('visible')) {
        hideProcessModal();
      }
    });
    
    // Request process stats for running attempts
    function requestProcessStats() {
      vscode.postMessage({ command: 'getProcessStats' });
    }
    
    // Initial load and periodic refresh
    const hasProcessTrees = document.querySelectorAll('.process-tree').length > 0;
    if (hasProcessTrees) {
      requestProcessStats();
      setInterval(requestProcessStats, 2000);
    }
    
    // Auto-refresh logs for running attempts
    setInterval(() => {
      document.querySelectorAll('.log-viewer').forEach(viewer => {
        if (viewer.getAttribute('data-running') === 'true' && viewer.style.display !== 'none') {
          const attemptBody = viewer.closest('.attempt-body');
          if (attemptBody && attemptBody.style.display !== 'none') {
            loadLog(viewer);
          }
        }
      });
    }, 2000);
    
    // Load initial logs for expanded attempts
    document.querySelectorAll('.attempt-body').forEach(body => {
      if (body.style.display !== 'none') {
        const logViewer = body.querySelector('.log-viewer');
        if (logViewer) {
          loadLog(logViewer);
        }
      }
    });
  <\/script>
</body>
</html>`;
  }

  context.subscriptions.push(vscode.commands.registerCommand('orchestrator.showJobSection', async (jobId?: string, section?: string) => {
    if (!jobId) {
      const jobs = runner.list();
      if (jobs.length === 0) {
        vscode.window.showInformationMessage('No jobs available');
        return;
      }
      const items = jobs.map(j => ({ 
        label: j.name, 
        description: `${j.status} - ${j.id.substring(0, 8)}...`, 
        detail: j.task,
        jobId: j.id
      }));
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select a job' });
      if (!pick) return;
      jobId = (pick as any).jobId;
    }
    
    if (!section) {
      const sectionPick = await vscode.window.showQuickPick(
        [
          { label: 'Prechecks', value: 'PRECHECKS' },
          { label: 'Work', value: 'WORK' },
          { label: 'Postchecks', value: 'POSTCHECKS' },
          { label: 'Full Log', value: 'FULL' }
        ],
        { placeHolder: 'Select section to view' }
      );
      if (!sectionPick) return;
      section = (sectionPick as any).value;
    }
    
    const job = runner.list().find(j => j.id === jobId);
    if (!job || !job.logFile || !require('fs').existsSync(job.logFile)) {
      vscode.window.showErrorMessage('Log file not found');
      return;
    }
    
    const fs = require('fs');
    const fullLog = fs.readFileSync(job.logFile, 'utf-8');
    
    let filteredLog = '';
    if (section === 'FULL') {
      filteredLog = fullLog;
    } else {
      const startMarker = `========== ${section} SECTION START ==========`;
      const endMarker = `========== ${section} SECTION END ==========`;
      const startIdx = fullLog.indexOf(startMarker);
      const endIdx = fullLog.indexOf(endMarker);
      
      if (startIdx >= 0 && endIdx >= 0) {
        filteredLog = fullLog.substring(startIdx, endIdx + endMarker.length);
      } else {
        filteredLog = `Section ${section} not found in log file.\n\n${fullLog}`;
      }
    }
    
    // Create temp file with filtered content
    const path = require('path');
    const tempDir = context.globalStorageUri.fsPath;
    require('fs').mkdirSync(tempDir, { recursive: true });
    const tempFile = path.join(tempDir, `${job.name}-${section}.log`);
    fs.writeFileSync(tempFile, filteredLog, 'utf-8');
    
    const doc = await vscode.workspace.openTextDocument(tempFile);
    await vscode.window.showTextDocument(doc, { preview: false });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('orchestrator.retryJob', async (jobId?: string, updatedWorkContext?: string) => {
    if (!jobId) {
      const jobs = runner.list().filter(j => j.status === 'failed' || j.status === 'canceled');
      if (jobs.length === 0) {
        vscode.window.showInformationMessage('No failed or canceled jobs to retry');
        return;
      }
      const items = jobs.map(j => ({ 
        label: j.name, 
        description: `${j.status} at ${j.currentStep || 'unknown step'} - ${j.id.substring(0, 8)}...`, 
        jobId: j.id 
      }));
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select job to retry' });
      if (!pick) return;
      jobId = (pick as any).jobId;
    }
    
    const job = runner.list().find(j => j.id === jobId);
    if (!job || !jobId) return;
    
    const confirmedJobId = jobId; // TypeScript type narrowing
    (runner as any).retry(confirmedJobId, updatedWorkContext);
    const contextMsg = updatedWorkContext ? ' with updated context' : ' with AI analysis';
    vscode.window.showInformationMessage(`Job "${job.name}" queued for retry${contextMsg}`);
    updateUI();
    
    // Refresh the job details panel if it's open for this job
    const panel = jobDetailPanels.get(confirmedJobId);
    if (panel) {
      const updatedJob = runner.list().find(j => j.id === confirmedJobId);
      if (updatedJob) {
        panel.webview.html = getJobDetailsHtml(updatedJob, panel.webview);
      }
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('orchestrator.deleteJob', async (jobId?: string) => {
    if (!jobId) {
      const jobs = runner.list();
      const items = jobs.map(j => ({ label: j.name, description: `${j.status} - ${j.id.substring(0, 8)}...`, jobId: j.id }));
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select job to delete' });
      if (!pick) return;
      jobId = (pick as any).jobId;
    }
    
    const job = runner.list().find(j => j.id === jobId);
    if (!job) {
      vscode.window.showErrorMessage(`Job ${jobId} not found`);
      return;
    }
    
    const warningMsg = job.status === 'running' 
      ? `Job "${job.name}" is currently running. It will be stopped and deleted. Continue?`
      : `Delete job "${job.name}"?`;
    
    const confirm = await vscode.window.showWarningMessage(
      warningMsg,
      { modal: true },
      'Delete'
    );
    
    if (confirm === 'Delete') {
      const success = (runner as any).delete(jobId);
      if (success) {
        vscode.window.showInformationMessage(`Job "${job.name}" deleted`);
        updateUI();
      } else {
        vscode.window.showErrorMessage(`Failed to delete job "${job.name}"`);
      }
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('orchestrator.openJobWorktree', async (jobId?: string) => {
    if (!jobId) {
      const jobs = runner.list();
      const items = jobs.map(j => ({ label: j.name, description: `${j.status} - ${j.id.substring(0, 8)}...`, jobId: j.id }));
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select job worktree to open' });
      if (!pick) return;
      jobId = (pick as any).jobId;
    }
    
    const job = runner.list().find(j => j.id === jobId);
    if (!job) return;
    
    const worktreePath = require('path').join(job.inputs.repoPath, job.inputs.worktreeRoot, job.id);
    const uri = vscode.Uri.file(worktreePath);
    
    const choice = await vscode.window.showInformationMessage(
      `Open worktree for "${job.name}"?`,
      'Open in New Window',
      'Open in Current Window',
      'Reveal in Explorer'
    );
    
    if (choice === 'Open in New Window') {
      vscode.commands.executeCommand('vscode.openFolder', uri, true);
    } else if (choice === 'Open in Current Window') {
      vscode.commands.executeCommand('vscode.openFolder', uri, false);
    } else if (choice === 'Reveal in Explorer') {
      vscode.commands.executeCommand('revealFileInOS', uri);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('orchestrator.mergeCompletedJob', async () => {
    const jobs = runner.list().filter(j=> j.status==='succeeded'); if (!jobs.length) return vscode.window.showInformationMessage('No succeeded jobs to merge.');
    const pick = await vscode.window.showQuickPick(jobs.map(j=>({label:j.id, description:j.inputs.targetBranch})), { placeHolder: 'Pick job to merge into base' });
    if (!pick) return; vscode.window.showInformationMessage(`Job ${pick.label} already merged (or handled by auto-merge).`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('orchestrator.resolveConflicts', async () => {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; if (!ws) return;
    const files = (await import('./gitApi')).listConflicts(ws); if (!files.length) { vscode.window.showInformationMessage('No merge conflicts detected.'); return; }
    const side = await vscode.window.showQuickPick(['theirs','ours'], { placeHolder: 'Prefer which side by default?' }); if (!side) return;
    for (const f of files) { await (await import('./gitApi')).checkoutSide(ws, side as any, f); }
    await (await import('./gitApi')).stageAll(ws); const ok = await (await import('./gitApi')).commit(ws, `orchestrator: resolved conflicts preferring ${side}`);
    vscode.window.showInformationMessage(ok? 'Conflicts resolved and committed.' : 'Resolution applied; commit may be required.');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('orchestrator.generateTests', async () => {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; if (!ws) return; const rc = await TaskRunner.runShell('orchestrator:gen-tests','npm run gen:tests || echo "no generator"', ws);
    vscode.window.showInformationMessage(`Generate tests exit ${rc}`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('orchestrator.produceDocs', async () => {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; if (!ws) return; const rc = await TaskRunner.runShell('orchestrator:docs','npm run docs || docfx build || echo "no docs step"', ws);
    vscode.window.showInformationMessage(`Docs step exit ${rc}`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('orchestrator.createJob', async () => { vscode.commands.executeCommand('orchestrator.startJob'); }));
  context.subscriptions.push(vscode.commands.registerCommand('orchestrator.openDashboard', () => {
    if (!dashboard) {
      dashboard = createDashboard(context);
      context.subscriptions.push(dashboard);
    }
    updateUI();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('orchestrator.cancelJob', async (jobId?: string) => {
    if (!jobId) {
      const items = runner.list()
        .filter(j => j.status === 'running' || j.status === 'queued')
        .map(j => ({label: j.name, description: `${j.status} - ${j.id.substring(0, 8)}...`, jobId: j.id}));
      
      if (items.length === 0) {
        vscode.window.showInformationMessage('No running or queued jobs to cancel');
        return;
      }
      
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select a job to cancel' });
      if (!pick) return;
      jobId = (pick as any).jobId;
    }
    
    const job = runner.list().find(j => j.id === jobId);
    (runner as any).cancel(jobId); 
    vscode.window.showWarningMessage(`Job "${job?.name || jobId}" canceled`);
    updateUI();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('orchestrator.mcp.howToConnect', async () => {
    const cfg = vscode.workspace.getConfiguration('copilotOrchestrator.mcp');
    const host = String(cfg.get('host')||'127.0.0.1');
    const port = Number(cfg.get('port')||39217);
    const snippet = `Local MCP Orchestrator is running.
Tools available:
- orchestrator.job.create / orchestrator.job.status
- orchestrator.plan.create / orchestrator.plan.status / orchestrator.plan.cancel
Endpoint: http://${host}:${port}
If your Agent requires stdio, run: node server/mcp-server.js`;
    await vscode.env.clipboard.writeText(snippet);
    vscode.window.showInformationMessage('MCP connection details copied to clipboard.');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('orchestrator.mcp.configure', async () => {
    await promptMcpServerRegistration(context);
  }));
  
  console.log('Copilot Orchestrator extension activated successfully');
  vscode.window.showInformationMessage('Copilot Orchestrator is ready!');
}

async function promptMcpServerRegistration(context: vscode.ExtensionContext) {
  // Check if user has already been prompted
  const hasPrompted = context.globalState.get<boolean>('mcpServerPrompted', false);
  if (hasPrompted) return;

  // Check if MCP is enabled in extension settings
  const mcpConfig = vscode.workspace.getConfiguration('copilotOrchestrator.mcp');
  if (!mcpConfig.get<boolean>('enabled', true)) return;

  const host = mcpConfig.get<string>('host', '127.0.0.1');
  const port = mcpConfig.get<number>('port', 39217);
  
  // Show prompt with options
  const choice = await vscode.window.showInformationMessage(
    'Copilot Orchestrator MCP server is running. Would you like to add it to GitHub Copilot Chat for agent-based job creation?',
    'Add to Copilot',
    'Copy Instructions',
    'Not Now',
    'Don\'t Show Again'
  );

  if (choice === 'Add to Copilot') {
    const serverPath = vscode.Uri.joinPath(context.extensionUri, 'server', 'mcp-server.js').fsPath;
    const config = {
      mcpServers: {
        'copilot-orchestrator': {
          command: 'node',
          args: [serverPath],
          env: {
            ORCH_HOST: host,
            ORCH_PORT: String(port)
          }
        }
      }
    };
    
    const configJson = JSON.stringify(config, null, 2);
    await vscode.env.clipboard.writeText(configJson);
    
    const openSettings = await vscode.window.showInformationMessage(
      'MCP server configuration copied to clipboard! Add this to your GitHub Copilot settings (usually in ~/.copilot/config.json or VS Code settings).',
      'Open Settings',
      'Show Instructions'
    );
    
    if (openSettings === 'Open Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'github.copilot');
    } else if (openSettings === 'Show Instructions') {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(context.extensionUri, 'docs', 'COPILOT_INTEGRATION.md'));
      vscode.window.showTextDocument(doc);
    }
    
    context.globalState.update('mcpServerPrompted', true);
  } else if (choice === 'Copy Instructions') {
    const instructions = `# Add Copilot Orchestrator to GitHub Copilot Chat

1. Locate your Copilot configuration file:
   - Windows: %USERPROFILE%\\.copilot\\config.json
   - Mac/Linux: ~/.copilot/config.json
   - Or in VS Code settings (search for "github.copilot.mcpServers")

2. Add this configuration:

{
  "mcpServers": {
    "copilot-orchestrator": {
      "command": "node",
      "args": ["${vscode.Uri.joinPath(context.extensionUri, 'server', 'mcp-server.js').fsPath}"],
      "env": {
        "ORCH_HOST": "${host}",
        "ORCH_PORT": "${port}"
      }
    }
  }
}

3. Reload VS Code or restart Copilot Chat

4. Test by asking: "Use the Copilot Orchestrator to create a job for [task]"

HTTP API is also available at: http://${host}:${port}
`;
    
    await vscode.env.clipboard.writeText(instructions);
    vscode.window.showInformationMessage('Instructions copied to clipboard!');
    context.globalState.update('mcpServerPrompted', true);
  } else if (choice === 'Don\'t Show Again') {
    context.globalState.update('mcpServerPrompted', true);
  }
  // 'Not Now' - don't update state, will prompt again next time
}

export function deactivate() {}
