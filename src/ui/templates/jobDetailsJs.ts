/**
 * @fileoverview JavaScript for job details panel webview.
 * 
 * Contains all client-side JavaScript for the job details panel including:
 * - Attempt expand/collapse
 * - Log loading and auto-refresh
 * - Process tree rendering
 * - Process modal interactions
 * - Keyboard shortcuts
 * 
 * @module ui/templates/jobDetailsJs
 */

/**
 * Get the JavaScript code for the job details panel.
 * This runs in the webview context with access to VS Code API.
 * 
 * @param jobJson - JSON stringified job object for initial state
 */
export function getJobDetailsJs(jobJson: string): string {
  return `
    const vscode = acquireVsCodeApi();
    let currentJob = ${jobJson};
    
    // ==========================================
    // HELPER FUNCTIONS
    // ==========================================
    
    function formatDuration(seconds) {
      if (seconds < 60) return seconds + 's';
      if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
      const hours = Math.floor(seconds / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      return hours + 'h ' + mins + 'm';
    }
    
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
    
    function formatDate(dateStr) {
      if (!dateStr) return '-';
      try {
        const d = new Date(dateStr);
        return d.toLocaleString();
      } catch (e) {
        return '-';
      }
    }
    
    // ==========================================
    // LIVE DURATION
    // ==========================================
    
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
    
    if (currentJob.status === 'running') {
      updateLiveDuration();
      setInterval(updateLiveDuration, 1000);
    }
    
    // ==========================================
    // ATTEMPT EXPAND/COLLAPSE
    // ==========================================
    
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
          
          const logViewer = body.querySelector('.log-viewer');
          if (logViewer && logViewer.textContent.includes('Loading log...')) {
            loadLog(logViewer);
          }
        }
      });
    });
    
    // ==========================================
    // PROCESS TREE EXPAND/COLLAPSE
    // ==========================================
    
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
    
    // ==========================================
    // WORK SUMMARY EXPAND/COLLAPSE
    // ==========================================
    
    document.querySelectorAll('.work-summary-box[data-expandable="true"]').forEach(box => {
      const header = box.querySelector('.work-summary-header');
      if (header) {
        header.addEventListener('click', (e) => {
          const detailsPanel = box.querySelector('.work-summary-details-panel');
          const isExpanded = box.classList.contains('expanded');
          
          if (isExpanded) {
            box.classList.remove('expanded');
            if (detailsPanel) detailsPanel.style.display = 'none';
          } else {
            box.classList.add('expanded');
            if (detailsPanel) detailsPanel.style.display = 'block';
          }
        });
      }
    });
    
    // ==========================================
    // LOG TAB HANDLING
    // ==========================================
    
    document.querySelectorAll('.log-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        const tabs = tab.parentElement;
        const section = tab.getAttribute('data-section');
        const attemptBody = tab.closest('.attempt-body');
        const logViewer = attemptBody.querySelector('.log-viewer');
        
        // Skip if already active
        if (tab.classList.contains('active')) return;
        
        tabs.querySelectorAll('.log-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        logViewer.setAttribute('data-section', section);
        
        // Show loading indicator immediately for visual feedback
        const currentScroll = document.documentElement.scrollTop || document.body.scrollTop;
        logViewer.classList.add('loading-content');
        logViewer.innerHTML = '<div class="loading-indicator">⏳ Loading ' + (section === 'FULL' ? 'full log' : section.toLowerCase() + ' section') + '...</div>';
        loadLog(logViewer);
        
        // Restore scroll position after a brief delay
        requestAnimationFrame(() => {
          document.documentElement.scrollTop = currentScroll;
          document.body.scrollTop = currentScroll;
        });
      });
    });
    
    // ==========================================
    // LOG VIEWER KEYBOARD SHORTCUTS
    // ==========================================
    
    document.querySelectorAll('.log-viewer').forEach(logViewer => {
      logViewer.setAttribute('tabindex', '0');
      logViewer.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'a') {
          e.preventDefault();
          e.stopPropagation();
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(logViewer);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          window.getSelection().removeAllRanges();
        }
        if (e.ctrlKey && e.key === 'c') {
          const selectedText = window.getSelection().toString();
          if (selectedText) {
            e.preventDefault();
            vscode.postMessage({ command: 'copyToClipboard', text: selectedText });
          }
        }
      });
      logViewer.addEventListener('click', () => logViewer.focus());
    });
    
    // ==========================================
    // SESSION ID COPY
    // ==========================================
    
    document.querySelectorAll('.session-id').forEach(el => {
      el.addEventListener('click', (e) => {
        const sessionId = el.getAttribute('data-session');
        vscode.postMessage({ command: 'copyToClipboard', text: sessionId });
      });
    });
    
    // ==========================================
    // ACTION BUTTONS
    // ==========================================
    
    document.querySelectorAll('.action-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        if (btn.disabled) return;
        
        const action = btn.getAttribute('data-action');
        const jobId = btn.getAttribute('data-job-id');
        
        btn.disabled = true;
        
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
    
    // ==========================================
    // LOG LOADING
    // ==========================================
    
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
    
    // Auto-scroll tracking
    const autoScrollEnabled = new WeakMap();
    
    document.querySelectorAll('.log-viewer').forEach(viewer => {
      autoScrollEnabled.set(viewer, true);
      
      viewer.addEventListener('scroll', () => {
        const isAtBottom = viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < 50;
        autoScrollEnabled.set(viewer, isAtBottom);
      });
    });
    
    // ==========================================
    // MESSAGE HANDLING
    // ==========================================
    
    window.addEventListener('message', event => {
      const message = event.data;
      
      if (message.command === 'updateJobData') {
        // Incremental update of job data without full HTML re-render
        const job = message.job;
        currentJob = job;
        
        // Update status badge
        const statusBadge = document.getElementById('job-status-badge');
        if (statusBadge) {
          statusBadge.className = 'status-badge ' + job.status;
          const statusText = { running: '● Running', queued: '◯ Queued', succeeded: '✓ Succeeded', failed: '✗ Failed', canceled: '⊘ Canceled' };
          statusBadge.textContent = statusText[job.status] || job.status;
        }
        
        // Update current step
        const stepEl = document.getElementById('job-current-step');
        if (stepEl && job.currentStep) {
          stepEl.textContent = job.currentStep;
        }
        
        // Update step status badges
        if (job.stepStatuses) {
          for (const [step, status] of Object.entries(job.stepStatuses)) {
            const stepBadge = document.getElementById('step-' + step);
            if (stepBadge) {
              stepBadge.className = 'phase-badge ' + status;
              const icons = { success: '✓', failed: '✗', running: '●', pending: '○', skipped: '–' };
              stepBadge.innerHTML = (icons[status] || '○') + ' ' + step.charAt(0).toUpperCase() + step.slice(1);
            }
          }
        }
        
        // Update duration if job completed
        if (job.status !== 'running' && job.status !== 'queued') {
          const liveDur = document.querySelector('.live-duration');
          if (liveDur && job.startedAt && job.endedAt) {
            const elapsed = Math.floor((job.endedAt - job.startedAt) / 1000);
            liveDur.textContent = formatDuration(elapsed);
            liveDur.classList.remove('live-duration');
          }
        }
        
        // Update action buttons visibility
        const cancelBtn = document.querySelector('.action-btn[data-action="cancel"]');
        const retryBtn = document.querySelector('.action-btn[data-action="retry"]');
        const deleteBtn = document.querySelector('.action-btn[data-action="delete"]');
        
        if (cancelBtn) {
          cancelBtn.style.display = (job.status === 'running' || job.status === 'queued') ? 'inline-block' : 'none';
        }
        if (retryBtn) {
          retryBtn.style.display = (job.status === 'failed' || job.status === 'canceled') ? 'inline-block' : 'none';
        }
        if (deleteBtn) {
          deleteBtn.style.display = (job.status !== 'running' && job.status !== 'queued') ? 'inline-block' : 'none';
        }
        
        // Update log viewer running state
        document.querySelectorAll('.log-viewer').forEach(viewer => {
          const wasRunning = viewer.getAttribute('data-running') === 'true';
          const isRunning = job.status === 'running';
          viewer.setAttribute('data-running', isRunning ? 'true' : 'false');
          
          // If just completed, load final log state
          if (wasRunning && !isRunning) {
            loadLog(viewer);
          }
        });
        
        return;
      }
      
      if (message.command === 'updateLogContent') {
        document.querySelectorAll('.log-viewer').forEach(viewer => {
          if (viewer.getAttribute('data-log') === message.logPath &&
              viewer.getAttribute('data-section') === message.section) {
            
            // Remove loading state
            viewer.classList.remove('loading-content');
            
            // Update content
            const newContent = message.content || 'No log content';
            const shouldAutoScroll = autoScrollEnabled.get(viewer) !== false;
            const scrollTop = viewer.scrollTop;
            
            viewer.textContent = newContent;
            
            if (viewer.getAttribute('data-running') === 'true' && shouldAutoScroll) {
              viewer.scrollTop = viewer.scrollHeight;
            } else {
              // Preserve scroll position for non-running logs
              viewer.scrollTop = scrollTop;
            }
          }
        });
      } else if (message.command === 'updateProcessStats') {
        renderProcessTree(message.stats);
      }
    });
    
    // ==========================================
    // PROCESS TREE RENDERING
    // ==========================================
    
    let lastKnownStats = [];
    
    function renderProcessTree(stats) {
      if (!stats || stats.length === 0) {
        if (lastKnownStats.length === 0) {
          document.querySelectorAll('.process-tree').forEach(tree => {
            tree.innerHTML = '<div class="loading">No active processes</div>';
          });
          document.querySelectorAll('.process-tree-title').forEach(title => {
            title.textContent = 'Running Processes';
          });
        }
        return;
      }
      
      lastKnownStats = stats;
      
      function countProcesses(proc) {
        let count = 1;
        if (proc.children && proc.children.length > 0) {
          proc.children.forEach(child => { count += countProcesses(child); });
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
        return { cpu: acc.cpu + procTotals.cpu, memory: acc.memory + procTotals.memory };
      }, { cpu: 0, memory: 0 });
      
      const totalMemMB = (totals.memory / 1024 / 1024).toFixed(1);
      const totalCpuPercent = totals.cpu.toFixed(0);
      
      document.querySelectorAll('.process-tree-title').forEach(title => {
        title.innerHTML = 'Running Processes <span style="opacity: 0.7; font-weight: normal;">(' + totalCount + ' processes • ' + totalCpuPercent + '% CPU • ' + totalMemMB + ' MB)</span>';
      });
      
      function renderProcess(proc, depth = 0, parentPid = null) {
        const memMB = (proc.memory / 1024 / 1024).toFixed(1);
        const cpuPercent = (proc.cpu || 0).toFixed(0);
        
        let perfIcon = '🟢';
        let memClass = 'low';
        let cpuClass = 'low';
        
        if (proc.memory > 500 * 1024 * 1024) { perfIcon = '🔴'; memClass = 'high'; }
        else if (proc.memory > 200 * 1024 * 1024) { perfIcon = '🟡'; memClass = 'medium'; }
        if (proc.cpu > 80) { cpuClass = 'high'; }
        else if (proc.cpu > 30) { cpuClass = 'medium'; }
        
        const escapedCmdLine = (proc.commandLine || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const escapedExePath = (proc.executablePath || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const childPids = (proc.children || []).map(c => c.pid).join(',');
        
        const dataAttrs = 'data-pid="' + proc.pid + '" data-name="' + proc.name + '" data-cpu="' + cpuPercent + '" data-memory="' + memMB + '" data-cmdline="' + escapedCmdLine + '" data-parent-pid="' + (parentPid || proc.parentPid || '-') + '" data-perf-icon="' + perfIcon + '" data-threads="' + (proc.threadCount || 0) + '" data-handles="' + (proc.handleCount || 0) + '" data-priority="' + (proc.priority || 0) + '" data-created="' + (proc.creationDate || '') + '" data-exe-path="' + escapedExePath + '" data-children="' + childPids + '"';
        
        if (depth === 0) {
          let html = '<div class="process-node process-clickable" ' + dataAttrs + '><div class="process-node-main"><div class="process-node-left"><span class="process-perf-icon">' + perfIcon + '</span><div class="process-node-info"><div class="process-node-name">' + proc.name + '</div><div class="process-node-pid">PID ' + proc.pid + '</div>' + (proc.commandLine ? '<div class="process-node-cmdline">' + proc.commandLine + '</div>' : '') + '</div></div><div class="process-node-stats"><div class="process-stat"><div class="process-stat-label">CPU</div><div class="process-stat-value ' + cpuClass + '">' + cpuPercent + '%</div></div><div class="process-stat"><div class="process-stat-label">Memory</div><div class="process-stat-value ' + memClass + '">' + memMB + ' MB</div></div></div></div>';
          
          if (proc.children && proc.children.length > 0) {
            html += '<div class="process-children">';
            proc.children.forEach(child => { html += renderProcess(child, depth + 1, proc.pid); });
            html += '</div>';
          }
          html += '</div>';
          return html;
        } else {
          const indent = depth * 20;
          let html = '<div class="process-child process-clickable" style="margin-left: ' + indent + 'px;" ' + dataAttrs + '><div class="process-child-main"><div class="process-child-left"><span class="process-perf-icon">' + perfIcon + '</span><span class="process-child-arrow">↳</span><span class="process-child-name">' + proc.name + '</span><span class="process-child-pid">PID ' + proc.pid + '</span></div><div class="process-child-stats"><div class="process-stat"><div class="process-stat-label">CPU</div><div class="process-stat-value ' + cpuClass + '">' + cpuPercent + '%</div></div><div class="process-stat"><div class="process-stat-label">Memory</div><div class="process-stat-value ' + memClass + '">' + memMB + ' MB</div></div></div></div>' + (proc.commandLine ? '<div class="process-child-cmdline">' + proc.commandLine + '</div>' : '') + '</div>';
          
          if (proc.children && proc.children.length > 0) {
            proc.children.forEach(child => { html += renderProcess(child, depth + 1, proc.pid); });
          }
          return html;
        }
      }
      
      const html = stats.map(proc => renderProcess(proc)).join('');
      
      document.querySelectorAll('.process-tree').forEach(tree => {
        tree.innerHTML = html;
        tree.querySelectorAll('.process-clickable').forEach(node => {
          node.addEventListener('click', (e) => {
            e.stopPropagation();
            showProcessModal(node);
          });
        });
      });
    }
    
    // ==========================================
    // PROCESS MODAL
    // ==========================================
    
    const processModal = document.getElementById('processModal');
    const closeModalBtn = document.getElementById('closeProcessModal');
    
    function findProcessNodeByPid(pid) {
      return document.querySelector('.process-clickable[data-pid="' + pid + '"]');
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
      document.getElementById('modalThreads').textContent = threads;
      document.getElementById('modalHandles').textContent = handles;
      document.getElementById('modalPriority').textContent = priority;
      document.getElementById('modalUptime').textContent = formatUptime(creationDate);
      
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
      if (e.target === processModal) hideProcessModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && processModal.classList.contains('visible')) hideProcessModal();
    });
    
    // ==========================================
    // PROCESS STATS POLLING
    // ==========================================
    
    function requestProcessStats() {
      vscode.postMessage({ command: 'getProcessStats' });
    }
    
    const hasProcessTrees = document.querySelectorAll('.process-tree').length > 0;
    if (hasProcessTrees) {
      requestProcessStats();
      setInterval(requestProcessStats, 2000);
    }
    
    // ==========================================
    // AUTO-REFRESH LOGS
    // ==========================================
    
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
    
    // Load initial logs
    document.querySelectorAll('.attempt-body').forEach(body => {
      if (body.style.display !== 'none') {
        const logViewer = body.querySelector('.log-viewer');
        if (logViewer) loadLog(logViewer);
      }
    });
  `;
}
