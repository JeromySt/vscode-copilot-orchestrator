/**
 * @fileoverview Release management webview scripts template.
 *
 * Orchestrates bundled webview controls and wires view-specific logic
 * for the adaptive release management wizard.
 *
 * @module ui/templates/release/scriptsTemplate
 */

import type { ReleaseDefinition } from '../../../plan/types/release';
import type { AvailablePlanSummary } from '../../panels/releaseManagementPanel';

/**
 * Render the webview `<script>` block for the release management view.
 *
 * @param release - Release definition data.
 * @param nonce - CSP nonce for script execution.
 * @param availablePlans - Real plan summaries from the plan runner.
 * @returns HTML `<script>…</script>` string.
 */
export function renderReleaseScripts(release: ReleaseDefinition, nonce: string, availablePlans: AvailablePlanSummary[] = []): string {
  return `<script nonce="${nonce}">
    // ── Data Injection ──────────────────────────────────────────────────
    const vscode = acquireVsCodeApi();
    const releaseData = ${JSON.stringify(release)};
    const availablePlans = ${JSON.stringify(availablePlans)};

    // ── Destructure from Bundle ─────────────────────────────────────────
    const { EventBus, SubscribableControl, Topics } = window.Orca || {};

    // Global bus instance
    const bus = EventBus ? new EventBus() : null;

    // ── Message Handlers ────────────────────────────────────────────────
    
    function proceedFromConfigure() {
      const flowType = releaseData.flowType;
      if (flowType === 'from-plans' && releaseData.planIds.length > 0) {
        vscode.postMessage({ type: 'startMerge' });
      } else {
        vscode.postMessage({ type: 'startPrepare' });
      }
    }
    
    function executeTask(taskId) {
      vscode.postMessage({ type: 'executeTask', taskId });
    }
    
    function skipTask(taskId) {
      vscode.postMessage({ type: 'skipTask', taskId });
    }
    
    function markTaskComplete(taskId) {
      vscode.postMessage({ type: 'markTaskComplete', taskId });
    }
    
    function createPR() {
      vscode.postMessage({ type: 'createPR' });
    }
    
    function adoptPR() {
      const input = document.getElementById('pr-number-input');
      const prNumber = input ? parseInt(input.value, 10) : null;
      if (prNumber && !isNaN(prNumber)) {
        vscode.postMessage({ type: 'adoptPR', prNumber });
      } else {
        alert('Please enter a valid PR number');
      }
    }
    
    function startMonitoring() {
      vscode.postMessage({ type: 'startMonitoring' });
    }
    
    function pauseMonitoring() {
      vscode.postMessage({ type: 'pauseMonitoring' });
    }
    
    function stopMonitoring() {
      vscode.postMessage({ type: 'stopMonitoring' });
    }
    
    function openPlanSelector() {
      vscode.postMessage({ type: 'openPlanSelector' });
    }
    
    function cancelRelease() {
      vscode.postMessage({ type: 'cancelRelease' });
    }
    
    function scaffoldTaskFiles() {
      vscode.postMessage({ type: 'scaffoldTasks' });
    }
    
    function refresh() {
      vscode.postMessage({ type: 'refresh' });
    }
    
    function viewTaskLog(taskId) {
      // Toggle log area visibility
      const logArea = document.getElementById(\`task-log-\${taskId}\`);
      if (logArea) {
        if (logArea.style.display === 'none') {
          logArea.style.display = 'block';
        } else {
          logArea.style.display = 'none';
        }
      }
      // Also notify extension to open the log file
      vscode.postMessage({ type: 'viewTaskLog', taskId });
    }

    // ── Plan Selection Control ──────────────────────────────────────────
    
    class PlanSelectorControl {
      constructor(containerId) {
        this.containerId = containerId;
        this.selectedPlans = new Set(releaseData.planIds || []);
        this.render();
      }
      
      render() {
        const container = document.getElementById(this.containerId);
        if (!container) return;
        
        if (availablePlans.length === 0) {
          container.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--vscode-descriptionForeground);">No succeeded plans available</div>';
          return;
        }
        
        container.innerHTML = availablePlans.map(plan => {
          const isSelected = this.selectedPlans.has(plan.id);
          const statusClass = plan.status === 'succeeded' ? 'succeeded' : 'running';
          
          return \`
            <div class="plan-item \${isSelected ? 'selected' : ''}" onclick="planSelector.toggle('\${plan.id}')">
              <input type="checkbox" class="plan-checkbox" \${isSelected ? 'checked' : ''} onclick="event.stopPropagation()">
              <div class="plan-info">
                <div class="plan-name">\${plan.name}</div>
                <div class="plan-details">\${plan.nodeCount} jobs</div>
              </div>
              <span class="plan-status-badge \${statusClass}">\${plan.status}</span>
            </div>
          \`;
        }).join('');
      }
      
      toggle(planId) {
        if (this.selectedPlans.has(planId)) {
          this.selectedPlans.delete(planId);
          vscode.postMessage({ type: 'removePlan', planId });
        } else {
          this.selectedPlans.add(planId);
          vscode.postMessage({ type: 'addPlan', planId });
        }
        this.render();
      }
    }
    
    // ── Preparation Tasks Control ───────────────────────────────────────
    
    class PrepTasksControl {
      constructor() {
        this.tasks = releaseData.prepTasks || [];
      }
      
      updateTask(taskId, status, error) {
        const task = this.tasks.find(t => t.id === taskId);
        if (task) {
          task.status = status;
          if (error) task.error = error;
          this.renderTask(taskId);
          this.updateProgress();
        }
      }
      
      renderTask(taskId) {
        const taskEl = document.querySelector(\`.prep-task[data-task-id="\${taskId}"]\`);
        if (!taskEl) return;
        
        const task = this.tasks.find(t => t.id === taskId);
        if (!task) return;
        
        const statusIcon = task.status === 'completed' ? '✓' : 
                         task.status === 'skipped' ? '−' :
                         task.status === 'running' ? '⏳' : '☐';
        
        taskEl.setAttribute('data-status', task.status);
        const checkbox = taskEl.querySelector('.task-checkbox');
        if (checkbox) {
          checkbox.textContent = statusIcon;
          checkbox.className = \`task-checkbox \${task.status}\`;
        }
        
        // Update actions
        const actions = taskEl.querySelector('.task-actions');
        if (actions && task.status === 'pending') {
          const html = [];
          if (task.autoSupported) {
            html.push('<button class="auto-btn" onclick="executeTask(\\\'' + task.id + '\\\')" title="Let Copilot handle this">🤖 Auto</button>');
          } else {
            html.push('<button class="manual-btn" onclick="markTaskComplete(\\\'' + task.id + '\\\')" title="Mark as complete">✓ Done</button>');
          }
          html.push('<button class="skip-btn" onclick="skipTask(\\\'' + task.id + '\\\')" title="Skip this task">Skip</button>');
          actions.innerHTML = html.join('');
        } else if (actions) {
          actions.innerHTML = '';
        }
      }
      
      updateProgress() {
        const completed = this.tasks.filter(t => t.status === 'completed' || t.status === 'skipped').length;
        const total = this.tasks.length;
        const percentage = total > 0 ? (completed / total) * 100 : 0;
        
        const progressFill = document.querySelector('.prep-progress-fill');
        if (progressFill) {
          progressFill.style.width = percentage + '%';
        }
        
        // Update button state
        const required = this.tasks.filter(t => t.required);
        const requiredCompleted = required.filter(t => t.status === 'completed' || t.status === 'skipped').length;
        const canCreatePR = requiredCompleted === required.length;
        
        const createPRBtn = document.querySelector('.create-pr-btn');
        if (createPRBtn) {
          createPRBtn.disabled = !canCreatePR;
          if (!canCreatePR) {
            createPRBtn.textContent = \`Create PR (\${required.length - requiredCompleted} required remaining)\`;
          } else {
            createPRBtn.textContent = 'Create PR →';
          }
        }
      }
      
      appendLogLine(taskId, line) {
        const logArea = document.getElementById(\`task-log-\${taskId}\`);
        if (!logArea) return;
        
        const logContent = logArea.querySelector('.task-log-content');
        if (logContent) {
          logContent.textContent += line + '\\n';
          logContent.scrollTop = logContent.scrollHeight;
        }
      }
    }
    
    // ── Merge Progress Control ──────────────────────────────────────────
    
    class MergeProgressControl {
      constructor() {
        this.mergeResults = [];
        this.render();
      }
      
      update(results) {
        this.mergeResults = results || [];
        this.render();
      }
      
      render() {
        const container = document.getElementById('merge-list');
        if (!container) return;
        
        if (this.mergeResults.length === 0) {
          container.innerHTML = releaseData.planIds.map((planId, idx) => \`
            <div class="merge-item">
              <div class="merge-status-icon pending">⏳</div>
              <div class="merge-info">
                <div class="merge-plan-name">Plan \${idx + 1}</div>
                <div class="merge-status-text">Waiting to merge...</div>
              </div>
            </div>
          \`).join('');
          return;
        }
        
        container.innerHTML = this.mergeResults.map(result => {
          const icon = result.success ? '✓' : (result.error ? '✗' : '⏳');
          const iconClass = result.success ? 'success' : (result.error ? 'failed' : 'merging');
          const statusText = result.success ? 'Merged successfully' : 
                           (result.error ? result.error : 'Merging...');
          
          return \`
            <div class="merge-item">
              <div class="merge-status-icon \${iconClass}">\${icon}</div>
              <div class="merge-info">
                <div class="merge-plan-name">\${result.planName || result.planId}</div>
                <div class="merge-status-text">\${statusText}</div>
              </div>
            </div>
          \`;
        }).join('');
        
        const completed = this.mergeResults.filter(r => r.success).length;
        const total = this.mergeResults.length;
        const percentage = total > 0 ? (completed / total) * 100 : 0;
        
        const progressBar = document.getElementById('overall-merge-progress');
        if (progressBar) {
          progressBar.style.width = percentage + '%';
          if (percentage === 100) {
            progressBar.classList.add('completed');
          }
        }
      }
    }
    
    // ── PR Monitor Control ──────────────────────────────────────────────
    
    class PRMonitorControl {
      constructor() {
        this.stats = {
          checksPass: 0,
          checksFail: 0,
          unresolvedComments: 0,
          unresolvedAlerts: 0
        };
        this.cycles = [];
        this.isMonitoring = false;
        this.countdownSeconds = 2400; // 40 minutes
        this.render();
      }
      
      update(data) {
        if (data) {
          this.stats = data;
          this.render();
        }
      }
      
      addCycle(cycle) {
        this.cycles.push(cycle);
        this.renderCycles();
      }
      
      startMonitoring() {
        this.isMonitoring = true;
        document.getElementById('start-monitor-btn').style.display = 'none';
        document.getElementById('pause-monitor-btn').style.display = 'inline-block';
        document.getElementById('stop-monitor-btn').style.display = 'inline-block';
        document.getElementById('monitor-timer').style.display = 'inline-block';
        this.startCountdown();
      }
      
      pauseMonitoring() {
        this.isMonitoring = false;
        document.getElementById('pause-monitor-btn').textContent = 'Resume Monitoring';
        document.getElementById('pause-monitor-btn').onclick = () => this.resumeMonitoring();
      }
      
      resumeMonitoring() {
        this.isMonitoring = true;
        document.getElementById('pause-monitor-btn').textContent = 'Pause Monitoring';
        document.getElementById('pause-monitor-btn').onclick = () => this.pauseMonitoring();
      }
      
      stopMonitoring() {
        this.isMonitoring = false;
        document.getElementById('start-monitor-btn').style.display = 'inline-block';
        document.getElementById('pause-monitor-btn').style.display = 'none';
        document.getElementById('stop-monitor-btn').style.display = 'none';
        document.getElementById('monitor-timer').style.display = 'none';
      }
      
      startCountdown() {
        const countdownEl = document.getElementById('countdown');
        const updateCountdown = () => {
          if (!this.isMonitoring) return;
          
          const minutes = Math.floor(this.countdownSeconds / 60);
          const seconds = this.countdownSeconds % 60;
          countdownEl.textContent = \`\${minutes}:\${seconds.toString().padStart(2, '0')}\`;
          
          if (this.countdownSeconds > 0) {
            this.countdownSeconds--;
            setTimeout(updateCountdown, 1000);
          } else {
            this.countdownSeconds = 2400;
            updateCountdown();
          }
        };
        updateCountdown();
      }
      
      render() {
        const updateStat = (id, value) => {
          const el = document.getElementById(id);
          if (el) el.textContent = value;
        };
        
        updateStat('checks-passing', this.stats.checksPass);
        updateStat('checks-failing', this.stats.checksFail);
        updateStat('comments-unresolved', this.stats.unresolvedComments);
        updateStat('alerts-unresolved', this.stats.unresolvedAlerts);
      }
      
      renderCycles() {
        const container = document.getElementById('cycle-dots');
        if (!container) return;
        
        if (this.cycles.length === 0) {
          container.innerHTML = \`
            <div style="padding: 20px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 11px;">
              No monitoring cycles yet
            </div>
          \`;
          return;
        }
        
        container.innerHTML = this.cycles.map((cycle, idx) => {
          const isActive = idx === this.cycles.length - 1;
          const hasIssues = cycle.actions && cycle.actions.length > 0;
          const dotClass = isActive ? 'active' : (hasIssues ? 'partial' : 'success');
          
          return \`<div class="cycle-dot \${dotClass}" title="Cycle \${cycle.cycleNumber}"></div>\`;
        }).join('');
      }
    }
    
    // ── Action Log Control ──────────────────────────────────────────────
    
    class ActionLogControl {
      constructor() {
        this.actions = [];
        this.render();
      }
      
      addAction(action) {
        this.actions.unshift(action);
        this.render();
      }
      
      render() {
        const container = document.getElementById('action-log-entries');
        if (!container) return;
        
        if (this.actions.length === 0) {
          container.innerHTML = \`
            <div style="padding: 20px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 11px;">
              No actions taken yet. The system will autonomously address feedback as it arrives.
            </div>
          \`;
          return;
        }
        
        container.innerHTML = this.actions.map(action => {
          const typeLabel = action.type.replace(/-/g, ' ').replace(/\\b\\w/g, l => l.toUpperCase());
          const statusClass = action.success ? 'success' : 'failed';
          const statusText = action.success ? '✓ Success' : '✗ Failed';
          const timestamp = new Date(action.timestamp || Date.now()).toLocaleTimeString();
          
          return \`
            <div class="action-entry \${action.type}">
              <div class="action-timestamp">\${timestamp}</div>
              <div class="action-content">
                <div class="action-type">
                  \${typeLabel}
                  <span class="action-status \${statusClass}">\${statusText}</span>
                </div>
                <div class="action-description">\${action.description}</div>
              </div>
            </div>
          \`;
        }).join('');
      }
    }

    // ── Initialize Controls ─────────────────────────────────────────────
    
    let planSelector, optionalPlanSelector, prepTasks, mergeProgress, prMonitor, actionLog;
    
    if (releaseData.status === 'drafting') {
      if (releaseData.flowType === 'from-plans') {
        planSelector = new PlanSelectorControl('plan-list');
      } else {
        optionalPlanSelector = new PlanSelectorControl('optional-plan-list');
      }
    } else if (releaseData.status === 'preparing') {
      prepTasks = new PrepTasksControl();
    } else if (releaseData.status === 'merging') {
      mergeProgress = new MergeProgressControl();
    } else if (releaseData.status === 'monitoring' || releaseData.status === 'addressing') {
      prMonitor = new PRMonitorControl();
      actionLog = new ActionLogControl();
    }

    // ── Listen for Messages from Extension ──────────────────────────────
    
    window.addEventListener('message', event => {
      const message = event.data;
      
      switch (message.type) {
        case 'pulse':
          // Update any time-based displays
          break;
          
        case 'taskUpdate':
          if (prepTasks && message.taskId) {
            prepTasks.updateTask(message.taskId, message.status, message.error);
          }
          break;
          
        case 'taskOutput':
          if (prepTasks && message.taskId && message.line) {
            prepTasks.appendLogLine(message.taskId, message.line);
          }
          break;
          
        case 'mergeProgress':
          if (mergeProgress) {
            mergeProgress.update(message.results);
          }
          break;
          
        case 'prUpdate':
          if (prMonitor) {
            prMonitor.update(message.stats);
          }
          break;
          
        case 'cycleCompleted':
          if (prMonitor && message.cycle) {
            prMonitor.addCycle(message.cycle);
          }
          break;
          
        case 'actionTaken':
          if (actionLog) {
            actionLog.addAction(message.action);
          }
          break;
      }
    });
  </script>`;
}
