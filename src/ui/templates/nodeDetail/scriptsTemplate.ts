/**
 * @fileoverview Webview JavaScript template for node detail panel.
 *
 * Generates the `<script>` block content for the node detail webview,
 * including event handlers, postMessage calls, process tree rendering,
 * duration timers, and phase tab selection logic.
 *
 * @module ui/templates/nodeDetail/scriptsTemplate
 */

/**
 * Configuration parameters for the webview scripts.
 */
export interface ScriptsConfig {
  /** The Plan ID (JSON-safe string) */
  planId: string;
  /** The Node ID (JSON-safe string) */
  nodeId: string;
  /** Previously selected phase, or null */
  currentPhase: string | null;
  /** Phase to show on initial load */
  initialPhase: string | null;
  /** Current node status */
  nodeStatus: string;
}

/**
 * Generate the complete webview `<script>` block content.
 *
 * Includes all client-side behavior: Ctrl+C copy, phase tab selection,
 * retry/force-fail button handlers, attempt card toggles, process tree
 * rendering, live duration timer, and message listeners.
 *
 * @param config - Configuration parameters for script generation.
 * @returns The script block content as a string (without `<script>` tags).
 */
export function webviewScripts(config: ScriptsConfig): string {
  return `
    const vscode = acquireVsCodeApi();
    const PLAN_ID = ${JSON.stringify(config.planId)};
    const NODE_ID = ${JSON.stringify(config.nodeId)};
    let currentPhase = ${config.currentPhase ? JSON.stringify(config.currentPhase) : 'null'};
    const initialPhase = ${config.initialPhase ? JSON.stringify(config.initialPhase) : 'null'};
    
    // Global Ctrl+C handler for copying selected text in webview
    document.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        const selectedText = window.getSelection().toString();
        if (selectedText) {
          e.preventDefault();
          vscode.postMessage({ type: 'copyToClipboard', text: selectedText });
        }
      }
    });
    
    // Auto-select a phase on load: restore previous selection, or use initial phase
    const phaseToSelect = currentPhase || initialPhase;
    if (phaseToSelect) {
      setTimeout(() => selectPhase(phaseToSelect), 50);
    }
    
    function openPlan(planId) {
      vscode.postMessage({ type: 'openPlan', planId });
    }
    
    function openWorktree() {
      vscode.postMessage({ type: 'openWorktree' });
    }
    
    function refresh() {
      vscode.postMessage({ type: 'refresh' });
    }
    
    // Session ID copy handler - using event delegation for dynamic content
    document.body.addEventListener('click', (e) => {
      if (!(e.target instanceof Element)) return;
      const target = e.target.closest('.session-id');
      if (target) {
        const sessionId = target.getAttribute('data-session');
        vscode.postMessage({ type: 'copyToClipboard', text: sessionId });
      }
    });
    
    // Log file path click handler - using event delegation
    document.body.addEventListener('click', (e) => {
      if (!(e.target instanceof Element)) return;
      const target = e.target.closest('.log-file-path');
      if (target) {
        const path = target.getAttribute('data-path');
        if (path) {
          vscode.postMessage({ type: 'openLogFile', path });
        }
      }
    });
    
    // Retry button handlers - using event delegation for dynamic content
    document.body.addEventListener('click', (e) => {
      if (!(e.target instanceof Element)) return;
      const btn = e.target.closest('.retry-btn');
      if (!btn) return;
      
      const action = btn.getAttribute('data-action');
      // Use global constants for planId/nodeId - more reliable than data attributes
      const planId = PLAN_ID;
      const nodeId = NODE_ID;
      
      if (action === 'retry-node') {
        vscode.postMessage({ type: 'retryNode', planId, nodeId, resumeSession: true });
      } else if (action === 'retry-node-fresh') {
        vscode.postMessage({ type: 'retryNode', planId, nodeId, resumeSession: false });
      } else if (action === 'force-fail-node') {
        // Request confirmation from extension (browser confirm() doesn't work in webviews)
        vscode.postMessage({ type: 'confirmForceFailNode', planId, nodeId });
      }
    });
    
    // Attempt card toggle handlers - using event delegation
    document.body.addEventListener('click', (e) => {
      if (!(e.target instanceof Element)) return;
      const header = e.target.closest('.attempt-header');
      if (!header) return;
      
      const card = header.closest('.attempt-card');
      const body = card.querySelector('.attempt-body');
      const chevron = header.querySelector('.chevron');
      const isExpanded = header.getAttribute('data-expanded') === 'true';
      
      if (isExpanded) {
        body.style.display = 'none';
        chevron.classList.remove('expanded');
        chevron.textContent = '▶';
        header.setAttribute('data-expanded', 'false');
      } else {
        body.style.display = 'block';
        chevron.classList.add('expanded');
        chevron.textContent = '▼';
        header.setAttribute('data-expanded', 'true');
      }
    });
    
    // Attempt phase tab click handlers - using event delegation
    document.body.addEventListener('click', (e) => {
      const tab = e.target.closest('.attempt-phase-tab');
      if (!tab) return;
      
      e.stopPropagation();
      const phase = tab.getAttribute('data-phase');
      const attemptNum = tab.getAttribute('data-attempt');
      const phasesContainer = tab.closest('.attempt-phases');
      
      // Update active tab
      phasesContainer.querySelectorAll('.attempt-phase-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      // Get logs data from the JSON script element
      const dataEl = phasesContainer.querySelector('.attempt-logs-data[data-attempt="' + attemptNum + '"]');
      if (dataEl) {
        try {
          const logsData = JSON.parse(dataEl.textContent);
          const viewer = phasesContainer.querySelector('.attempt-log-viewer[data-attempt="' + attemptNum + '"]');
          if (viewer && logsData[phase]) {
            viewer.textContent = logsData[phase];
          }
        } catch (err) {
          console.error('Failed to parse attempt logs data:', err);
        }
      }
    });
    
    function selectPhase(phase) {
      currentPhase = phase;
      
      // Update tab selection
      document.querySelectorAll('.phase-tab').forEach(t => t.classList.remove('active'));
      document.querySelector('[data-phase="' + phase + '"]').classList.add('active');
      
      // Show loading state
      document.getElementById('logViewer').innerHTML = '<div class="log-loading">Loading logs...</div>';
      
      // Request log content
      vscode.postMessage({ type: 'getLog', phase });
    }
    
    // Handle log content messages
    // Track last log content to avoid unnecessary updates
    let lastLogContent = '';
    
    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'logContent' && msg.phase === currentPhase) {
        const viewer = document.getElementById('logViewer');
        
        // Skip update if content hasn't changed
        if (msg.content === lastLogContent) {
          return;
        }
        
        // Skip update if user has text selected (don't disrupt their selection)
        const selection = window.getSelection();
        if (selection && selection.toString().length > 0) {
          // User has selection - defer update (will get it on next refresh when they deselect)
          return;
        }
        
        lastLogContent = msg.content;
        
        // Check if user was at bottom before updating content
        // Allow some tolerance (50px) for "at bottom" detection
        const wasAtBottom = viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < 50;
        
        viewer.innerHTML = '<pre class="log-content" tabindex="0">' + escapeHtml(msg.content) + '</pre>';
        
        // Only auto-scroll if user was already at bottom (respect manual scrolling)
        if (wasAtBottom) {
          viewer.scrollTop = viewer.scrollHeight;
        }
        
        // Setup log viewer keyboard shortcuts
        const logContent = viewer.querySelector('.log-content');
        if (logContent) {
          logContent.addEventListener('click', () => logContent.focus());
          logContent.addEventListener('keydown', function(e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
              e.preventDefault();
              e.stopPropagation();
              const selection = window.getSelection();
              const range = document.createRange();
              range.selectNodeContents(logContent);
              selection.removeAllRanges();
              selection.addRange(range);
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              window.getSelection().removeAllRanges();
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
              const selectedText = window.getSelection().toString();
              if (selectedText) {
                e.preventDefault();
                vscode.postMessage({ type: 'copyToClipboard', text: selectedText });
              }
            }
          });
        }
      }
      
      // Handle process stats messages
      if (msg.type === 'processStats') {
        renderProcessTree(msg);
      }
    });
    
    // Process tree rendering
    let lastKnownTree = [];
    
    function renderProcessTree(stats) {
      const treeEl = document.getElementById('processTree');
      const titleEl = document.getElementById('processTreeTitle');
      if (!treeEl || !titleEl) return;
      
      // Handle agent work without a process (waiting for CLI to start)
      if (stats.isAgentWork && !stats.pid && stats.running) {
        const duration = stats.duration ? formatDuration(stats.duration) : '';
        treeEl.innerHTML = '<div class="agent-work-indicator"><span class="agent-icon">🤖</span> Copilot Agent starting...' + (duration ? ' <span class="agent-duration">(' + duration + ')</span>' : '') + '</div>';
        titleEl.innerHTML = 'Agent Work <span style="opacity: 0.7; font-weight: normal;">(starting)</span>';
        return;
      }
      
      if (!stats.pid || !stats.running) {
        if (lastKnownTree.length === 0) {
          treeEl.innerHTML = '<div class="process-loading">No active process</div>';
          titleEl.textContent = 'Processes';
        }
        return;
      }
      
      const tree = stats.tree || [];
      lastKnownTree = tree;
      
      // Add agent indicator to title if this is agent work
      const agentPrefix = stats.isAgentWork ? '🤖 ' : '';
      
      if (tree.length === 0) {
        treeEl.innerHTML = '<div class="process-loading">' + agentPrefix + 'Process running (PID ' + stats.pid + ')</div>';
        titleEl.innerHTML = (stats.isAgentWork ? 'Copilot Agent' : 'Processes') + ' <span style="opacity: 0.7; font-weight: normal;">PID ' + stats.pid + '</span>';
        return;
      }
      
      // Count processes and sum stats
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
      const titleLabel = stats.isAgentWork ? 'Copilot Agent' : 'Processes';
      titleEl.innerHTML = titleLabel + ' <span style="opacity: 0.7; font-weight: normal;">(' + totals.count + ' • ' + totals.cpu.toFixed(0) + '% CPU • ' + memMB + ' MB)</span>';
      
      // Render process nodes
      function renderNode(proc, depth) {
        const memMB = ((proc.memory || 0) / 1024 / 1024).toFixed(1);
        const cpuPct = (proc.cpu || 0).toFixed(0);
        const indent = depth * 16;
        const arrow = depth > 0 ? '↳ ' : '';
        
        let html = '<div class="process-node" style="margin-left: ' + indent + 'px;">';
        html += '<div class="process-node-header">';
        html += '<span class="process-node-icon">⚙️</span>';
        html += '<span class="process-node-name">' + arrow + escapeHtml(proc.name) + '</span>';
        html += '<span class="process-node-pid">PID ' + proc.pid + '</span>';
        html += '</div>';
        html += '<div class="process-node-stats">';
        html += '<span class="process-stat">CPU: ' + cpuPct + '%</span>';
        html += '<span class="process-stat">Mem: ' + memMB + ' MB</span>';
        html += '</div>';
        if (proc.commandLine) {
          html += '<div class="process-node-cmdline">' + escapeHtml(proc.commandLine) + '</div>';
        }
        html += '</div>';
        
        if (proc.children) {
          for (const child of proc.children) {
            html += renderNode(child, depth + 1);
          }
        }
        
        return html;
      }
      
      treeEl.innerHTML = tree.map(p => renderNode(p, 0)).join('');
    }
    
    function formatDuration(ms) {
      const sec = Math.floor(ms / 1000);
      if (sec < 60) return sec + 's';
      const min = Math.floor(sec / 60);
      const remSec = sec % 60;
      return min + 'm ' + remSec + 's';
    }
    
    // Poll for process stats if running
    const processTreeSection = document.getElementById('processTreeSection');
    if (processTreeSection) {
      vscode.postMessage({ type: 'getProcessStats' });
      setInterval(() => {
        vscode.postMessage({ type: 'getProcessStats' });
      }, 1000);
    }

    // Live duration timer for running jobs
    const durationTimer = document.getElementById('duration-timer');
    if (durationTimer && durationTimer.hasAttribute('data-started-at')) {
      const startedAt = parseInt(durationTimer.getAttribute('data-started-at'), 10);
      const nodeStatus = ${JSON.stringify(config.nodeStatus)};
      
      // Clear any existing timer to prevent duplicates
      if (window.nodeDurationTimer) {
        clearInterval(window.nodeDurationTimer);
      }
      
      // Only run timer if node is running
      if (nodeStatus === 'running' && startedAt) {
        window.nodeDurationTimer = setInterval(() => {
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          const elem = document.getElementById('duration-timer');
          if (elem) {
            elem.textContent = formatDuration(elapsed * 1000);
          }
        }, 1000);
      }
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
  `;
}
