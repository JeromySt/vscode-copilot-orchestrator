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
  // Safely serialize data for embedding in a <script> tag.
  // JSON.stringify doesn't escape </script> or <!, which would prematurely
  // close the script tag if present in comment bodies or other user content.
  const safeJson = (obj: unknown): string =>
    JSON.stringify(obj)
      .replace(/<\//g, '<\\/')     // </script> → <\/script>
      .replace(/<!--/g, '<\\!--'); // <!-- → <\!--

  return `<script nonce="${nonce}">
    // ── Data Injection ──────────────────────────────────────────────────
    const vscode = acquireVsCodeApi();
    const releaseData = ${safeJson(release)};
    const availablePlans = ${safeJson(availablePlans)};

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
    
    function retryTask(taskId) {
      vscode.postMessage({ type: 'retryTask', taskId });
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
    
    function deleteRelease() {
      vscode.postMessage({ type: 'deleteRelease' });
    }
    
    function retryRelease() {
      vscode.postMessage({ type: 'retryRelease' });
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
    
    function acknowledgeFinding(taskId, findingId) {
      vscode.postMessage({ type: 'updateFinding', taskId, findingId, status: 'acknowledged' });
    }
    
    function dismissFinding(taskId, findingId) {
      vscode.postMessage({ type: 'updateFinding', taskId, findingId, status: 'dismissed' });
    }
    
    function openFindingFile(filePath, line) {
      vscode.postMessage({ type: 'openFindingFile', filePath, line });
    }

    function switchAccount() {
      vscode.postMessage({ type: 'switchAccount' });
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
        this.isMonitoring = releaseData.status === 'monitoring' || releaseData.status === 'addressing';
        this.countdownSeconds = 120; // 2 minutes (matches POLL_INTERVAL_MS)
        this.render();
        // Auto-start countdown if already monitoring
        if (this.isMonitoring) {
          this.startCountdown();
        }
      }
      
      update(data) {
        if (data) {
          this.stats = data;
          this.render();
          // Reset countdown on each update (new cycle just completed)
          this.countdownSeconds = 120;
        }
      }
      
      addCycle(cycle) {
        this.cycles.push(cycle);
        this.renderCycles();
        this.renderChecks(cycle);
        // Reset countdown (cycle just ran)
        this.countdownSeconds = 120;
      }
      
      onStopped() {
        this.isMonitoring = false;
        // Update countdown display to show stopped state
        const el = document.getElementById('countdown-display');
        if (el) {
          el.textContent = 'Stopped';
          el.style.color = 'var(--vscode-descriptionForeground)';
        }
        // Update the timer bar label
        const label = document.querySelector('.monitor-timer-label');
        if (label) {
          label.textContent = 'Monitoring idle';
        }
        const pollInfo = document.querySelector('.monitor-poll-info');
        if (pollInfo) {
          pollInfo.textContent = '(40 min timeout — click Start Monitoring to resume)';
        }
      }
      
      startCountdown() {
        const countdownEl = document.getElementById('countdown-display');
        if (!countdownEl) return;
        const self = this;
        const tick = () => {
          if (!self.isMonitoring) return;
          const el = document.getElementById('countdown-display');
          if (!el) return;
          const m = Math.floor(self.countdownSeconds / 60);
          const s = self.countdownSeconds % 60;
          el.textContent = m + ':' + (s < 10 ? '0' : '') + s;
          if (self.countdownSeconds > 0) {
            self.countdownSeconds--;
          } else {
            self.countdownSeconds = 120;
          }
          setTimeout(tick, 1000);
        };
        tick();
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
      
      renderChecks(cycle) {
        const container = document.getElementById('pr-checks-list');
        if (!container || !cycle || !cycle.checks || cycle.checks.length === 0) {
          if (container) container.innerHTML = '';
          return;
        }
        
        const checks = cycle.checks;
        const passing = checks.filter(c => c.status === 'passing');
        const failing = checks.filter(c => c.status === 'failing');
        const pending = checks.filter(c => c.status === 'pending');
        
        let html = '<h4 style="margin: 16px 0 8px 0; font-size: 13px; font-weight: 600;">CI/CD Checks (' + checks.length + ')</h4>';
        
        // Show failing first, then pending, then passing
        const ordered = [...failing, ...pending, ...passing];
        html += ordered.map(check => {
          const icon = check.status === 'passing' ? '\u2705' :
                      check.status === 'failing' ? '\u274C' : '\u23F3';
          const urlAttr = check.url ? ' data-check-url="' + check.url.replace(/"/g, '&quot;') + '"' : '';
          const urlLink = check.url ?
            '<a class="pr-check-url" href="#"' + urlAttr + ' title="View details">\u2197</a>' : '';
          return '<div class="pr-check-item ' + check.status + '">' +
            '<span class="pr-check-icon">' + icon + '</span>' +
            '<span class="pr-check-name">' + check.name + '</span>' +
            '<span class="pr-check-status-label">' + check.status + '</span>' +
            urlLink +
            '</div>';
        }).join('');
        
        container.innerHTML = html;
        
        // Wire up check URL clicks via event delegation
        container.querySelectorAll('.pr-check-url[data-check-url]').forEach(function(el) {
          el.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            var url = el.getAttribute('data-check-url');
            if (url) vscode.postMessage({ type: 'openExternal', url: url });
          });
        });
      }
    }
    
    // ── Pending Actions Control ──────────────────────────────────────────
    
    class PendingActionsControl {
      constructor() {
        this.findings = [];  // { type, id, ...data, aiStatus? }
        this.selected = new Set();
        this.filter = 'all';
        this.aiActive = false;
        this.render();
      }
      
      updateFromCycle(cycle) {
        // Build findings list from latest cycle data
        const newFindings = [];
        
        // Failing checks
        if (cycle.checks) {
          for (const check of cycle.checks) {
            if (check.status === 'failing') {
              newFindings.push({
                type: 'check',
                id: 'check-' + check.name.replace(/[^a-zA-Z0-9]/g, '-'),
                name: check.name,
                status: check.status,
                url: check.url,
                text: 'CI check "' + check.name + '" is failing',
                resolved: false,
              });
            }
          }
        }
        
        // Unresolved comments
        if (cycle.comments) {
          for (const comment of cycle.comments) {
            if (!comment.isResolved) {
              newFindings.push({
                type: 'comment',
                id: 'comment-' + comment.id,
                commentId: comment.id,
                author: comment.author,
                body: comment.body,
                path: comment.path,
                line: comment.line,
                source: comment.source,
                threadId: comment.threadId,
                text: comment.body,
                resolved: false,
              });
            }
          }
        }
        
        // Unresolved security alerts
        if (cycle.securityAlerts) {
          for (const alert of cycle.securityAlerts) {
            if (!alert.resolved) {
              newFindings.push({
                type: 'alert',
                id: 'alert-' + alert.id,
                alertId: alert.id,
                severity: alert.severity,
                description: alert.description,
                file: alert.file,
                text: alert.description,
                resolved: false,
              });
            }
          }
        }
        
        // Merge: keep selection state for existing items
        const oldMap = new Map();
        for (const f of this.findings) { oldMap.set(f.id, f); }
        this.findings = newFindings.map(f => {
          const old = oldMap.get(f.id);
          if (old) { f.resolved = old.resolved; }
          return f;
        });
        
        // Remove selection for items no longer present
        const currentIds = new Set(this.findings.map(f => f.id));
        for (const sel of this.selected) {
          if (!currentIds.has(sel)) this.selected.delete(sel);
        }
        
        this.render();
      }
      
      getFiltered() {
        if (this.filter === 'all') return this.findings;
        return this.findings.filter(f => f.type === this.filter);
      }
      
      setFilter(filter) {
        this.filter = filter;
        this.render();
      }
      
      toggleSelect(id) {
        if (this.selected.has(id)) {
          this.selected.delete(id);
        } else {
          this.selected.add(id);
        }
        this.updateToolbar();
      }
      
      selectAll() {
        const filtered = this.getFiltered();
        const allSelected = filtered.every(f => this.selected.has(f.id));
        if (allSelected) {
          for (const f of filtered) this.selected.delete(f.id);
        } else {
          for (const f of filtered) this.selected.add(f.id);
        }
        this.render();
      }
      
      markResolved(findingIds) {
        if (!Array.isArray(findingIds)) return;
        const idSet = new Set(findingIds);
        for (const f of this.findings) {
          if (idSet.has(f.id)) {
            f.resolved = true;
            f.aiStatus = 'fixed';
            this.selected.delete(f.id);
          }
        }
        this.aiActive = false;
        this._updateBanner();
        this.render();
      }
      
      setProcessing(findingIds, status) {
        if (!Array.isArray(findingIds)) return;
        const idSet = new Set(findingIds);
        for (const f of this.findings) {
          if (idSet.has(f.id)) {
            f.aiStatus = status; // 'queued', 'processing', 'fixed', 'failed'
          }
        }
        this.aiActive = (status === 'queued' || status === 'processing');
        this._updateBanner();
        this.render();
      }
      
      // Mark selected items as queued immediately (called before async AI work)
      markSelectedQueued() {
        for (const id of this.selected) {
          const f = this.findings.find(function(x) { return x.id === id; });
          if (f) f.aiStatus = 'queued';
        }
        this.aiActive = true;
        this._updateBanner();
        this.render();
      }
      
      _updateBanner() {
        const banner = document.getElementById('ai-working-banner');
        if (banner) {
          if (this.aiActive) {
            const count = this.findings.filter(function(f) { return f.aiStatus === 'queued' || f.aiStatus === 'processing'; }).length;
            banner.style.display = 'flex';
            banner.querySelector('.ai-banner-text').textContent = 'AI is working on ' + count + ' finding(s)...';
          } else {
            banner.style.display = 'none';
          }
        }
      }
      
      updateToolbar() {
        const toolbar = document.getElementById('pending-actions-toolbar');
        const countEl = document.getElementById('pending-selected-count');
        const selectAllEl = document.getElementById('pending-select-all');
        const fixBtn = document.getElementById('pending-fix-ai-btn');
        
        // Show toolbar whenever there are findings (not just when selected)
        if (toolbar) {
          toolbar.style.display = this.findings.length > 0 ? 'flex' : 'none';
        }
        if (countEl) {
          countEl.textContent = this.selected.size + ' selected';
        }
        // Update select-all checkbox state
        if (selectAllEl) {
          const filtered = this.getFiltered();
          const allSelected = filtered.length > 0 && filtered.every(f => this.selected.has(f.id));
          const someSelected = filtered.some(f => this.selected.has(f.id));
          selectAllEl.checked = allSelected;
          selectAllEl.indeterminate = someSelected && !allSelected;
        }
        // Enable/disable Fix button
        if (fixBtn) {
          fixBtn.disabled = this.selected.size === 0;
        }
      }
      
      openFinding(finding) {
        if (finding.type === 'comment' && finding.path) {
          vscode.postMessage({
            type: 'openPRComment',
            filePath: finding.path,
            line: finding.line || 1,
            author: finding.author,
            body: finding.body,
            source: finding.source,
          });
        } else if (finding.type === 'alert' && finding.file) {
          vscode.postMessage({
            type: 'openPRComment',
            filePath: finding.file,
            line: 1,
            author: 'Security',
            body: '[' + (finding.severity || '').toUpperCase() + '] ' + finding.description,
            source: 'codeql',
          });
        } else if (finding.type === 'check' && finding.url) {
          vscode.postMessage({ type: 'openExternal', url: finding.url });
        }
      }
      
      render() {
        const container = document.getElementById('pending-actions-list');
        if (!container) return;
        
        const filtered = this.getFiltered();
        
        if (filtered.length === 0) {
          const emptyText = this.findings.length === 0
            ? 'No findings yet. Pending actions will appear after the first monitoring cycle.'
            : 'No ' + this.filter + ' findings.';
          container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--vscode-descriptionForeground);font-size:11px;">' + emptyText + '</div>';
          this.updateToolbar();
          return;
        }
        
        container.innerHTML = filtered.map(f => this.renderItem(f)).join('');
        this._wireEvents(container);
        this.updateToolbar();
      }
      
      _wireEvents(container) {
        const self = this;
        // Wire checkbox changes
        container.querySelectorAll('.pending-action-checkbox').forEach(function(el) {
          el.addEventListener('change', function() {
            const id = el.closest('.pending-action-item').getAttribute('data-id');
            if (id) self.toggleSelect(id);
          });
        });
        // Wire location link clicks
        container.querySelectorAll('.pending-action-location').forEach(function(el) {
          el.addEventListener('click', function(e) {
            e.preventDefault();
            const id = el.getAttribute('data-finding-id');
            if (id) {
              const finding = self.findings.find(function(f) { return f.id === id; });
              if (finding) self.openFinding(finding);
            }
          });
        });
      }
      
      renderItem(finding) {
        const isChecked = this.selected.has(finding.id) ? 'checked' : '';
        const resolvedClass = finding.resolved ? ' resolved' : '';
        const processingClass = (finding.aiStatus === 'queued' || finding.aiStatus === 'processing') ? ' processing' : '';
        
        // AI status badge
        let aiStatusBadge = '';
        if (finding.aiStatus === 'queued') {
          aiStatusBadge = '<span class="pending-action-ai-status queued">\u23F3 Queued</span>';
        } else if (finding.aiStatus === 'processing') {
          aiStatusBadge = '<span class="pending-action-ai-status processing"><span class="ai-spinner"></span> Processing</span>';
        } else if (finding.aiStatus === 'fixed') {
          aiStatusBadge = '<span class="pending-action-ai-status fixed">\u2705 Fixed</span>';
        } else if (finding.aiStatus === 'failed') {
          aiStatusBadge = '<span class="pending-action-ai-status failed">\u274C Failed</span>';
        }
        
        let badge = '';
        let metaInfo = '';
        let locationHtml = '';
        let bodyText = '';
        
        if (finding.type === 'comment') {
          badge = '<span class="pending-action-type-badge comment">Comment</span>';
          metaInfo = '<span class="pending-action-author">' + this.esc(finding.author || '') + '</span>'
            + '<span class="pending-action-source">' + this.esc(finding.source || '') + '</span>';
          bodyText = this.esc(this.truncate(finding.body || '', 200));
          if (finding.path) {
            locationHtml = '<a class="pending-action-location" href="#" data-finding-id="' + finding.id + '" title="Open in editor">'
              + '\ud83d\udcc4 ' + this.esc(finding.path) + (finding.line ? ':' + finding.line : '')
              + '</a>';
          }
        } else if (finding.type === 'check') {
          badge = '<span class="pending-action-type-badge check">CI Check</span>';
          metaInfo = '<span class="pending-action-author">' + this.esc(finding.name || '') + '</span>';
          bodyText = 'Check is failing';
          if (finding.url) {
            locationHtml = '<a class="pending-action-location" href="#" data-finding-id="' + finding.id + '" title="View check details">'
              + '\ud83d\udd17 View details'
              + '</a>';
          }
        } else if (finding.type === 'alert') {
          badge = '<span class="pending-action-type-badge alert">Security</span>';
          const sev = (finding.severity || 'medium').toLowerCase();
          metaInfo = '<span class="pending-action-severity ' + sev + '">' + sev.toUpperCase() + '</span>';
          bodyText = this.esc(finding.description || '');
          if (finding.file) {
            locationHtml = '<a class="pending-action-location" href="#" data-finding-id="' + finding.id + '" title="Open in editor">'
              + '\ud83d\udcc4 ' + this.esc(finding.file)
              + '</a>';
          }
        }
        
        return '<div class="pending-action-item' + resolvedClass + processingClass + '" data-type="' + finding.type + '" data-id="' + finding.id + '">'
          + '<input type="checkbox" class="pending-action-checkbox" ' + isChecked + ' />'
          + '<div class="pending-action-body">'
          + '<div class="pending-action-meta">' + badge + metaInfo + aiStatusBadge + '</div>'
          + '<div class="pending-action-text">' + bodyText + '</div>'
          + (locationHtml ? '<div>' + locationHtml + '</div>' : '')
          + '</div>'
          + '</div>';
      }
      
      esc(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
      }
      
      truncate(str, max) {
        if (str.length <= max) return str;
        return str.substring(0, max) + '...';
      }
    }

    // Global functions called from HTML onclick handlers
    function filterPendingActions(filter, btn) {
      if (pendingActions) {
        pendingActions.setFilter(filter);
        // Update active button
        document.querySelectorAll('.pending-filter').forEach(b => b.classList.remove('active'));
        if (btn) btn.classList.add('active');
      }
    }
    
    function addressSelectedWithAI() {
      if (pendingActions && pendingActions.selected.size > 0) {
        // Mark selected items as queued immediately for instant feedback
        pendingActions.markSelectedQueued();
        const selectedFindings = pendingActions.findings.filter(f => pendingActions.selected.has(f.id));
        vscode.postMessage({ type: 'addressWithAI', findings: selectedFindings });
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
          container.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 11px;">No actions taken yet. Use "Fix with AI" on pending findings to start.</div>';
          return;
        }
        
        container.innerHTML = this.actions.map(function(action) {
          var icon = action.success
            ? (action.type === 'fix-code' ? '\u2699\uFE0F' : action.type === 'respond-comment' ? '\uD83D\uDCAC' : '\u2705')
            : '\u274C';
          var statusClass = action.success ? 'success' : 'failed';
          
          // Descriptive status label based on type + success
          var statusText = 'Done';
          if (!action.success) {
            statusText = 'Failed';
          } else if (action.type === 'fix-code' && action.commitHash) {
            statusText = 'Pushed';
          } else if (action.type === 'fix-code') {
            statusText = 'Applied';
          } else if (action.type === 'respond-comment') {
            statusText = 'Replied';
          }
          
          var timestamp = new Date(action.timestamp || Date.now()).toLocaleTimeString();
          var commitInfo = action.commitHash
            ? '<span class="action-commit">' + action.commitHash.substring(0, 7) + '</span>'
            : '';
          
          return '<div class="action-entry ' + action.type + ' ' + statusClass + '">'
            + '<div class="action-icon">' + icon + '</div>'
            + '<div class="action-content">'
            + '<div class="action-type">'
            + action.description
            + '<span class="action-status ' + statusClass + '">' + statusText + '</span>'
            + commitInfo
            + '</div>'
            + '<div class="action-timestamp">' + timestamp + '</div>'
            + '</div>'
            + '</div>';
        }).join('');
      }
    }
    
    // ── CLI Console Control ──────────────────────────────────────────────
    
    class CliConsoleControl {
      constructor() {
        this.sessions = [];
        this.expandedSession = null;
        this.render();
      }
      
      startSession(sessionId, label) {
        this.sessions.unshift({
          id: sessionId,
          label: label || 'Copilot CLI',
          lines: [],
          active: true,
          startTime: Date.now(),
        });
        this.expandedSession = sessionId;
        this.render();
      }
      
      appendLine(sessionId, line) {
        var session = this.sessions.find(function(s) { return s.id === sessionId; });
        if (!session) return;
        session.lines.push(line);
        if (this.expandedSession === sessionId) {
          this._appendToConsole(line);
        }
      }
      
      endSession(sessionId, success) {
        var session = this.sessions.find(function(s) { return s.id === sessionId; });
        if (session) {
          session.active = false;
          session.success = success;
          session.endTime = Date.now();
        }
        this.render();
      }
      
      _appendToConsole(line) {
        var pre = document.getElementById('cli-console-output');
        if (!pre) return;
        var lineEl = document.createElement('div');
        lineEl.className = 'cli-line';
        lineEl.textContent = line;
        pre.appendChild(lineEl);
        pre.scrollTop = pre.scrollHeight;
      }
      
      render() {
        var container = document.getElementById('cli-console-section');
        if (!container) return;
        
        if (this.sessions.length === 0) {
          container.style.display = 'none';
          return;
        }
        container.style.display = 'block';
        
        var header = document.getElementById('cli-console-header');
        var body = document.getElementById('cli-console-body');
        if (!header || !body) return;
        
        var self = this;
        header.innerHTML = this.sessions.map(function(s) {
          var statusIcon = s.active ? '<span class="ai-spinner"></span>' : (s.success ? '\u2705' : '\u274C');
          var selected = self.expandedSession === s.id ? ' selected' : '';
          var elapsed = '';
          if (s.startTime) {
            var ms = (s.endTime || Date.now()) - s.startTime;
            var sec = Math.floor(ms / 1000);
            elapsed = sec < 60 ? sec + 's' : Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
          }
          return '<button class="cli-session-tab' + (s.active ? ' active' : '') + selected + '" data-session-id="' + s.id + '">'
            + statusIcon + ' ' + s.label + ' <span class="cli-elapsed">' + elapsed + '</span>'
            + '</button>';
        }).join('');
        
        header.querySelectorAll('.cli-session-tab').forEach(function(tab) {
          tab.addEventListener('click', function() {
            self.expandedSession = tab.getAttribute('data-session-id');
            self.render();
          });
        });
        
        var session = this.sessions.find(function(s) { return s.id === self.expandedSession; });
        if (session) {
          body.innerHTML = '<pre class="cli-console-output" id="cli-console-output"></pre>';
          var pre = document.getElementById('cli-console-output');
          if (pre) {
            session.lines.forEach(function(line) {
              var lineEl = document.createElement('div');
              lineEl.className = 'cli-line';
              lineEl.textContent = line;
              pre.appendChild(lineEl);
            });
            pre.scrollTop = pre.scrollHeight;
          }
        } else {
          body.innerHTML = '<div style="padding:12px;text-align:center;color:var(--vscode-descriptionForeground);font-size:11px;">Select a session above</div>';
        }
      }
    }

    // ── Initialize Controls ─────────────────────────────────────────────
    
    let planSelector, optionalPlanSelector, prepTasks, mergeProgress, prMonitor, actionLog, pendingActions, cliConsole;
    
    if (releaseData.status === 'drafting') {
      if (releaseData.flowType === 'from-plans') {
        planSelector = new PlanSelectorControl('plan-list');
      } else {
        optionalPlanSelector = new PlanSelectorControl('optional-plan-list');
      }
      // Fetch git account on configure step
      fetchGitAccount();
    } else if (releaseData.status === 'preparing') {
      prepTasks = new PrepTasksControl();
    } else if (releaseData.status === 'merging') {
      mergeProgress = new MergeProgressControl();
    } else if (releaseData.status === 'monitoring' || releaseData.status === 'addressing' || releaseData.status === 'pr-active') {
      prMonitor = new PRMonitorControl();
      actionLog = new ActionLogControl();
      pendingActions = new PendingActionsControl();
      cliConsole = new CliConsoleControl();

      // Seed controls with the last cycle data if available (panel opened after cycle ran)
      if (releaseData.lastCycle) {
        prMonitor.addCycle(releaseData.lastCycle);
        pendingActions.updateFromCycle(releaseData.lastCycle);
        // Also update stats from the stored monitoringStats
        if (releaseData.monitoringStats) {
          prMonitor.update({
            checksPass: releaseData.monitoringStats.checksPass || 0,
            checksFail: releaseData.monitoringStats.checksFail || 0,
            unresolvedComments: releaseData.monitoringStats.unresolvedComments || 0,
            unresolvedAlerts: releaseData.monitoringStats.unresolvedAlerts || 0,
          });
        }
      }

      // Wire select-all checkbox
      var selectAllCb = document.getElementById('pending-select-all');
      if (selectAllCb && pendingActions) {
        selectAllCb.addEventListener('change', function() {
          pendingActions.selectAll();
        });
      }

      // Wire Fix with AI button
      var fixAiBtn = document.getElementById('pending-fix-ai-btn');
      if (fixAiBtn) {
        fixAiBtn.addEventListener('click', function() {
          addressSelectedWithAI();
        });
      }
    }

    // ── Fetch Git Account ───────────────────────────────────────────────
    
    function fetchGitAccount() {
      vscode.postMessage({ type: 'getGitAccount' });
    }

    function updateGitAccountDisplay(username) {
      const valueEl = document.getElementById('git-account-value');
      if (valueEl) {
        if (username) {
          valueEl.textContent = username;
          valueEl.style.color = 'var(--vscode-foreground)';
        } else {
          valueEl.textContent = 'Not configured';
          valueEl.style.color = 'var(--vscode-descriptionForeground)';
        }
      }
    }

    // ── Listen for Messages from Extension ──────────────────────────────
    
    window.addEventListener('message', event => {
      const message = event.data;
      
      switch (message.type) {
        case 'gitAccount':
          updateGitAccountDisplay(message.username);
          break;
          
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
          if (pendingActions && message.cycle) {
            pendingActions.updateFromCycle(message.cycle);
          }
          break;
          
        case 'actionTaken':
          if (actionLog) {
            actionLog.addAction(message.action);
          }
          break;
          
        case 'findingsResolved':
          if (pendingActions && message.findingIds) {
            pendingActions.markResolved(message.findingIds);
          }
          break;
          
        case 'findingsProcessing':
          if (pendingActions && message.findingIds) {
            pendingActions.setProcessing(message.findingIds, message.status);
          }
          break;
          
        case 'monitoringStopped':
          if (prMonitor) {
            prMonitor.onStopped();
          }
          break;
          
        case 'cliSessionStart':
          if (cliConsole && message.sessionId) {
            cliConsole.startSession(message.sessionId, message.label);
          }
          break;
          
        case 'cliSessionOutput':
          if (cliConsole && message.sessionId) {
            cliConsole.appendLine(message.sessionId, message.line);
          }
          break;
          
        case 'cliSessionEnd':
          if (cliConsole && message.sessionId) {
            cliConsole.endSession(message.sessionId, message.success);
          }
          break;
      }
    });
  </script>`;
}
