/**
 * @fileoverview Release management webview panel logic.
 *
 * Extracted from inline template literal to a proper TypeScript module so that
 * esbuild compiles it as browser-target code.  Regex literals, escape sequences,
 * and other JS constructs work correctly here instead of being mangled inside
 * a template string.
 *
 * Exported via the `release.ts` entry point → `dist/webview/release.js` (IIFE).
 * The HTML template injects a small inline `<script>` that calls
 * `window.Orca.initReleasePanel({ releaseData, availablePlans })`.
 *
 * @module ui/webview/releasePanel
 */

/// <reference lib="dom" />

/* ── Type shims (no importing vscode types in browser code) ────────── */

declare const acquireVsCodeApi: () => { postMessage(msg: unknown): void };

interface VsCodeApi {
  postMessage(msg: unknown): void;
}

/* ── Helpers ─────────────────────────────────────────────────────────── */

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** Escape HTML then convert Markdown `[text](url)` to clickable `<a>` tags. */
function mdLinks(str: string): string {
  const escaped = escapeHtml(str);
  // This regex is safe because it's in a real .ts file, not a template literal.
  return escaped.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_: string, text: string, url: string) => {
    return '<a class="md-link" href="#" data-url="' + url.replace(/"/g, '&quot;') + '">' + text + '</a>';
  });
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.substring(0, max) + '...';
}

/* ── Controls ────────────────────────────────────────────────────────── */

// Forward declarations so all functions/classes can reference each other.
let vscode: VsCodeApi;
let releaseData: any;
let availablePlans: any[];
let planSelector: PlanSelectorControl | undefined;
let optionalPlanSelector: PlanSelectorControl | undefined;
let prepTasks: PrepTasksControl | undefined;
let mergeProgress: MergeProgressControl | undefined;
let prMonitor: PRMonitorControl | undefined;
let actionLog: ActionLogControl | undefined;
let pendingActions: PendingActionsControl | undefined;
let cliConsole: CliConsoleControl | undefined;

/* ── Global functions (referenced by onclick attrs in HTML templates) ─ */

function proceedFromConfigure(): void {
  const flowType = releaseData.flowType;
  if (flowType === 'from-plans' && releaseData.planIds.length > 0) {
    vscode.postMessage({ type: 'startMerge' });
  } else {
    vscode.postMessage({ type: 'startPrepare' });
  }
}

function executeTask(taskId: string): void {
  vscode.postMessage({ type: 'executeTask', taskId });
}

function skipTask(taskId: string): void {
  vscode.postMessage({ type: 'skipTask', taskId });
}

function markTaskComplete(taskId: string): void {
  vscode.postMessage({ type: 'markTaskComplete', taskId });
}

function retryTask(taskId: string): void {
  vscode.postMessage({ type: 'retryTask', taskId });
}

function createPR(): void {
  vscode.postMessage({ type: 'createPR' });
}

function adoptPR(): void {
  const input = document.getElementById('pr-number-input') as HTMLInputElement | null;
  const prNumber = input ? parseInt(input.value, 10) : null;
  if (prNumber && !isNaN(prNumber)) {
    vscode.postMessage({ type: 'adoptPR', prNumber });
  } else {
    alert('Please enter a valid PR number');
  }
}

function startMonitoring(): void {
  vscode.postMessage({ type: 'startMonitoring' });
}

function pauseMonitoring(): void {
  vscode.postMessage({ type: 'pauseMonitoring' });
}

function stopMonitoring(): void {
  vscode.postMessage({ type: 'stopMonitoring' });
}

function openPlanSelector(): void {
  vscode.postMessage({ type: 'openPlanSelector' });
}

function cancelRelease(): void {
  vscode.postMessage({ type: 'cancelRelease' });
}

function deleteRelease(): void {
  vscode.postMessage({ type: 'deleteRelease' });
}

function retryRelease(): void {
  vscode.postMessage({ type: 'retryRelease' });
}

function scaffoldTaskFiles(): void {
  vscode.postMessage({ type: 'scaffoldTasks' });
}

function refresh(): void {
  vscode.postMessage({ type: 'refresh' });
}

function viewTaskLog(taskId: string): void {
  const logArea = document.getElementById(`task-log-${taskId}`);
  if (logArea) {
    logArea.style.display = logArea.style.display === 'none' ? 'block' : 'none';
  }
  vscode.postMessage({ type: 'viewTaskLog', taskId });
}

function acknowledgeFinding(taskId: string, findingId: string): void {
  vscode.postMessage({ type: 'updateFinding', taskId, findingId, status: 'acknowledged' });
}

function dismissFinding(taskId: string, findingId: string): void {
  vscode.postMessage({ type: 'updateFinding', taskId, findingId, status: 'dismissed' });
}

function openFindingFile(filePath: string, line: number): void {
  vscode.postMessage({ type: 'openFindingFile', filePath, line });
}

function switchAccount(): void {
  vscode.postMessage({ type: 'switchAccount' });
}

function filterPendingActions(filter: string, btn: HTMLElement | null): void {
  if (pendingActions) {
    pendingActions.setFilter(filter);
    document.querySelectorAll('.pending-filter').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
  }
}

function addressSelectedWithAI(): void {
  if (pendingActions && pendingActions.selected.size > 0) {
    // Exclude findings already being processed by a prior AI invocation
    const newFindings = pendingActions.findings.filter((f: any) =>
      pendingActions!.selected.has(f.id) &&
      f.aiStatus !== 'queued' && f.aiStatus !== 'processing'
    );
    if (newFindings.length === 0) return;
    // Only mark the new batch as queued
    for (const f of newFindings) f.aiStatus = 'queued';
    pendingActions.aiActive = true;
    pendingActions._updateBanner();
    pendingActions.render();
    vscode.postMessage({ type: 'addressWithAI', findings: newFindings });
  }
}

function fetchGitAccount(): void {
  vscode.postMessage({ type: 'getGitAccount' });
}

function updateGitAccountDisplay(username: string | null): void {
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

/* ── Plan Selection Control ──────────────────────────────────────────── */

class PlanSelectorControl {
  containerId: string;
  selectedPlans: Set<string>;

  constructor(containerId: string) {
    this.containerId = containerId;
    this.selectedPlans = new Set(releaseData.planIds || []);
    this.render();
  }

  render(): void {
    const container = document.getElementById(this.containerId);
    if (!container) return;

    if (availablePlans.length === 0) {
      container.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--vscode-descriptionForeground);">No succeeded plans available</div>';
      return;
    }

    container.innerHTML = availablePlans.map(plan => {
      const isSelected = this.selectedPlans.has(plan.id);
      const statusClass = plan.status === 'succeeded' ? 'succeeded' : 'running';
      return `
        <div class="plan-item ${isSelected ? 'selected' : ''}" onclick="planSelector.toggle('${plan.id}')">
          <input type="checkbox" class="plan-checkbox" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation()">
          <div class="plan-info">
            <div class="plan-name">${plan.name}</div>
            <div class="plan-details">${plan.nodeCount} jobs</div>
          </div>
          <span class="plan-status-badge ${statusClass}">${plan.status}</span>
        </div>
      `;
    }).join('');
  }

  toggle(planId: string): void {
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

/* ── Preparation Tasks Control ───────────────────────────────────────── */

class PrepTasksControl {
  tasks: any[];

  constructor() {
    this.tasks = releaseData.prepTasks || [];
  }

  updateTask(taskId: string, status: string, error?: string): void {
    const task = this.tasks.find(t => t.id === taskId);
    if (task) {
      task.status = status;
      if (error) task.error = error;
      this.renderTask(taskId);
      this.updateProgress();
    }
  }

  renderTask(taskId: string): void {
    const taskEl = document.querySelector(`.prep-task[data-task-id="${taskId}"]`);
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
      checkbox.className = `task-checkbox ${task.status}`;
    }

    const actions = taskEl.querySelector('.task-actions');
    if (actions && task.status === 'pending') {
      const html: string[] = [];
      if (task.autoSupported) {
        html.push('<button class="auto-btn" onclick="executeTask(\'' + task.id + '\')" title="Let Copilot handle this">🤖 Auto</button>');
      } else {
        html.push('<button class="manual-btn" onclick="markTaskComplete(\'' + task.id + '\')" title="Mark as complete">✓ Done</button>');
      }
      html.push('<button class="skip-btn" onclick="skipTask(\'' + task.id + '\')" title="Skip this task">Skip</button>');
      actions.innerHTML = html.join('');
    } else if (actions) {
      actions.innerHTML = '';
    }
  }

  updateProgress(): void {
    const completed = this.tasks.filter(t => t.status === 'completed' || t.status === 'skipped').length;
    const total = this.tasks.length;
    const percentage = total > 0 ? (completed / total) * 100 : 0;

    const progressFill = document.querySelector('.prep-progress-fill') as HTMLElement | null;
    if (progressFill) {
      progressFill.style.width = percentage + '%';
    }

    const required = this.tasks.filter(t => t.required);
    const requiredCompleted = required.filter(t => t.status === 'completed' || t.status === 'skipped').length;
    const canCreatePR = requiredCompleted === required.length;

    const createPRBtn = document.querySelector('.create-pr-btn') as HTMLButtonElement | null;
    if (createPRBtn) {
      createPRBtn.disabled = !canCreatePR;
      createPRBtn.textContent = canCreatePR
        ? 'Create PR →'
        : `Create PR (${required.length - requiredCompleted} required remaining)`;
    }
  }

  appendLogLine(taskId: string, line: string): void {
    const logArea = document.getElementById(`task-log-${taskId}`);
    if (!logArea) return;
    const logContent = logArea.querySelector('.task-log-content');
    if (logContent) {
      logContent.textContent += line + '\n';
      logContent.scrollTop = logContent.scrollHeight;
    }
  }
}

/* ── Merge Progress Control ──────────────────────────────────────────── */

class MergeProgressControl {
  mergeResults: any[];

  constructor() {
    this.mergeResults = [];
    this.render();
  }

  update(results: any[]): void {
    this.mergeResults = results || [];
    this.render();
  }

  render(): void {
    const container = document.getElementById('merge-list');
    if (!container) return;

    if (this.mergeResults.length === 0) {
      container.innerHTML = releaseData.planIds.map((planId: string, idx: number) => `
        <div class="merge-item">
          <div class="merge-status-icon pending">⏳</div>
          <div class="merge-info">
            <div class="merge-plan-name">Plan ${idx + 1}</div>
            <div class="merge-status-text">Waiting to merge...</div>
          </div>
        </div>
      `).join('');
      return;
    }

    container.innerHTML = this.mergeResults.map(result => {
      const icon = result.success ? '✓' : (result.error ? '✗' : '⏳');
      const iconClass = result.success ? 'success' : (result.error ? 'failed' : 'merging');
      const statusText = result.success ? 'Merged successfully' :
                         (result.error ? result.error : 'Merging...');
      return `
        <div class="merge-item">
          <div class="merge-status-icon ${iconClass}">${icon}</div>
          <div class="merge-info">
            <div class="merge-plan-name">${result.planName || result.planId}</div>
            <div class="merge-status-text">${statusText}</div>
          </div>
        </div>
      `;
    }).join('');

    const completed = this.mergeResults.filter(r => r.success).length;
    const total = this.mergeResults.length;
    const percentage = total > 0 ? (completed / total) * 100 : 0;

    const progressBar = document.getElementById('overall-merge-progress') as HTMLElement | null;
    if (progressBar) {
      progressBar.style.width = percentage + '%';
      if (percentage === 100) {
        progressBar.classList.add('completed');
      }
    }
  }
}

/* ── PR Monitor Control ──────────────────────────────────────────────── */

class PRMonitorControl {
  stats: { checksPass: number; checksFail: number; unresolvedThreads: number; unresolvedAlerts: number };
  cycles: any[];
  isMonitoring: boolean;
  countdownSeconds: number;

  constructor() {
    this.stats = { checksPass: 0, checksFail: 0, unresolvedThreads: 0, unresolvedAlerts: 0 };
    this.cycles = [];
    this.isMonitoring = releaseData.status === 'monitoring' || releaseData.status === 'addressing';
    this.countdownSeconds = 120;
    this.render();
    if (this.isMonitoring) {
      this.startCountdown();
    }
  }

  update(data: any): void {
    if (data) {
      this.stats = data;
      this.render();
      this.countdownSeconds = 120;
    }
  }

  addCycle(cycle: any): void {
    this.cycles.push(cycle);
    this.renderCycles();
    this.renderChecks(cycle);
    this.countdownSeconds = 120;
  }

  onStopped(): void {
    this.isMonitoring = false;
    const el = document.getElementById('countdown-display');
    if (el) {
      el.textContent = 'Stopped';
      el.style.color = 'var(--vscode-descriptionForeground)';
    }
    const label = document.querySelector('.monitor-timer-label');
    if (label) label.textContent = 'Monitoring idle';
    const pollInfo = document.querySelector('.monitor-poll-info');
    if (pollInfo) pollInfo.textContent = '(40 min timeout — click Start Monitoring to resume)';
  }

  startCountdown(): void {
    const self = this;
    const tick = () => {
      if (!self.isMonitoring) return;
      const el = document.getElementById('countdown-display');
      if (!el) return;
      const m = Math.floor(self.countdownSeconds / 60);
      const s = self.countdownSeconds % 60;
      el.textContent = m + ':' + (s < 10 ? '0' : '') + s;
      self.countdownSeconds = self.countdownSeconds > 0 ? self.countdownSeconds - 1 : 120;
      setTimeout(tick, 1000);
    };
    tick();
  }

  render(): void {
    const updateStat = (id: string, value: number) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(value);
    };
    updateStat('checks-passing', this.stats.checksPass);
    updateStat('checks-failing', this.stats.checksFail);
    updateStat('comments-unresolved', this.stats.unresolvedThreads);
    updateStat('alerts-unresolved', this.stats.unresolvedAlerts);
  }

  renderCycles(): void {
    const container = document.getElementById('cycle-dots');
    if (!container) return;

    const headerEl = container.closest('.pr-cycle-timeline');
    if (headerEl) {
      const h4 = headerEl.querySelector('h4');
      if (h4) h4.textContent = 'Monitoring Cycles (' + this.cycles.length + ')';
    }

    if (this.cycles.length === 0) {
      container.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 11px;">No monitoring cycles yet</div>';
      return;
    }

    const maxDots = 20;
    const startIdx = Math.max(0, this.cycles.length - maxDots);
    let html = '';

    if (startIdx > 0) {
      html += '<span style="font-size:10px;color:var(--vscode-descriptionForeground);margin-right:4px;">+' + startIdx + ' older</span>';
    }

    for (let i = startIdx; i < this.cycles.length; i++) {
      const cycle = this.cycles[i];
      const isLatest = i === this.cycles.length - 1;
      let hasFindings = false;
      if (cycle.checks) hasFindings = cycle.checks.some((c: any) => c.status === 'failing');
      if (!hasFindings && cycle.comments) hasFindings = cycle.comments.some((c: any) => !c.isResolved);
      if (!hasFindings && cycle.securityAlerts) hasFindings = cycle.securityAlerts.some((a: any) => !a.resolved);

      const dotClass = isLatest ? (hasFindings ? 'partial' : 'active') : (hasFindings ? 'partial' : 'success');
      html += '<div class="cycle-dot ' + dotClass + '" title="Cycle ' + cycle.cycleNumber + (hasFindings ? ' (has findings)' : ' (clean)') + '"></div>';
    }
    container.innerHTML = html;
  }

  renderChecks(cycle: any): void {
    const container = document.getElementById('pr-checks-list');
    if (!container || !cycle?.checks?.length) {
      if (container) container.innerHTML = '';
      return;
    }

    const checks = cycle.checks;
    const passing = checks.filter((c: any) => c.status === 'passing');
    const failing = checks.filter((c: any) => c.status === 'failing');
    const pending = checks.filter((c: any) => c.status === 'pending');

    let html = '<h4 style="margin: 16px 0 8px 0; font-size: 13px; font-weight: 600;">CI/CD Checks (' + checks.length + ')</h4>';
    const ordered = [...failing, ...pending, ...passing];
    html += ordered.map((check: any) => {
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

    container.querySelectorAll('.pr-check-url[data-check-url]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const url = (el as HTMLElement).getAttribute('data-check-url');
        if (url) vscode.postMessage({ type: 'openExternal', url });
      });
    });
  }
}

/* ── Pending Actions Control ─────────────────────────────────────────── */

class PendingActionsControl {
  findings: any[];
  selected: Set<string>;
  filter: string;
  aiActive: boolean;

  constructor() {
    this.findings = [];
    this.selected = new Set();
    this.filter = 'all';
    this.aiActive = false;
    this.render();
  }

  updateFromCycle(cycle: any): void {
    const newFindings: any[] = [];

    if (cycle.checks) {
      for (const check of cycle.checks) {
        if (check.status === 'failing') {
          newFindings.push({
            type: 'check',
            id: 'check-' + check.name.replace(/[^a-zA-Z0-9]/g, '-'),
            name: check.name, status: check.status, url: check.url,
            text: 'CI check "' + check.name + '" is failing', resolved: false,
          });
        }
      }
    }

    if (cycle.comments) {
      for (const comment of cycle.comments) {
        if (!comment.isResolved) {
          newFindings.push({
            type: 'comment', id: 'comment-' + comment.id,
            commentId: comment.id, author: comment.author, body: comment.body,
            path: comment.path, line: comment.line, source: comment.source,
            threadId: comment.threadId, url: comment.url,
            replies: comment.replies || [],
            text: comment.body, resolved: false,
          });
        }
      }
    }

    if (cycle.securityAlerts) {
      for (const alert of cycle.securityAlerts) {
        if (!alert.resolved) {
          newFindings.push({
            type: 'alert', id: 'alert-' + alert.id,
            alertId: alert.id, severity: alert.severity,
            description: alert.description, file: alert.file,
            text: alert.description, resolved: false,
          });
        }
      }
    }

    const oldMap = new Map<string, any>();
    for (const f of this.findings) oldMap.set(f.id, f);
    this.findings = newFindings.map(f => {
      const old = oldMap.get(f.id);
      if (old) f.resolved = old.resolved;
      return f;
    });

    const currentIds = new Set(this.findings.map(f => f.id));
    for (const sel of this.selected) {
      if (!currentIds.has(sel)) this.selected.delete(sel);
    }
    this.render();
  }

  getFiltered(): any[] {
    if (this.filter === 'all') return this.findings;
    return this.findings.filter(f => f.type === this.filter);
  }

  setFilter(filter: string): void { this.filter = filter; this.render(); }

  toggleSelect(id: string): void {
    // Prevent deselection while AI is working on this finding
    const finding = this.findings.find((f: any) => f.id === id);
    if (finding && (finding.aiStatus === 'queued' || finding.aiStatus === 'processing')) return;
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this.updateToolbar();
  }

  selectAll(): void {
    const filtered = this.getFiltered();
    const allSelected = filtered.every(f => this.selected.has(f.id));
    for (const f of filtered) {
      if (allSelected) this.selected.delete(f.id);
      else this.selected.add(f.id);
    }
    this.render();
  }

  markResolved(findingIds: string[]): void {
    if (!Array.isArray(findingIds)) return;
    const idSet = new Set(findingIds);
    for (const f of this.findings) {
      if (idSet.has(f.id)) { f.resolved = true; f.aiStatus = 'fixed'; this.selected.delete(f.id); }
    }
    this.aiActive = false;
    this._updateBanner();
    this.render();
  }

  setProcessing(findingIds: string[], status: string): void {
    if (!Array.isArray(findingIds)) return;
    const idSet = new Set(findingIds);
    for (const f of this.findings) { if (idSet.has(f.id)) f.aiStatus = status; }
    this.aiActive = (status === 'queued' || status === 'processing');
    this._updateBanner();
    this.render();
  }

  markSelectedQueued(): void {
    for (const id of this.selected) {
      const f = this.findings.find((x: any) => x.id === id);
      if (f) f.aiStatus = 'queued';
    }
    this.aiActive = true;
    this._updateBanner();
    this.render();
  }

  _updateBanner(): void {
    const banner = document.getElementById('ai-working-banner');
    if (!banner) return;
    if (this.aiActive) {
      const count = this.findings.filter((f: any) => f.aiStatus === 'queued' || f.aiStatus === 'processing').length;
      banner.style.display = 'flex';
      const text = banner.querySelector('.ai-banner-text');
      if (text) text.textContent = 'AI is working on ' + count + ' finding(s)...';
    } else {
      banner.style.display = 'none';
    }
  }

  updateToolbar(): void {
    const toolbar = document.getElementById('pending-actions-toolbar');
    const countEl = document.getElementById('pending-selected-count');
    const selectAllEl = document.getElementById('pending-select-all') as HTMLInputElement | null;
    const fixBtn = document.getElementById('pending-fix-ai-btn') as HTMLButtonElement | null;

    if (toolbar) toolbar.style.display = this.findings.length > 0 ? 'flex' : 'none';
    if (countEl) countEl.textContent = this.selected.size + ' selected';
    if (selectAllEl) {
      const filtered = this.getFiltered();
      const allSel = filtered.length > 0 && filtered.every(f => this.selected.has(f.id));
      const someSel = filtered.some(f => this.selected.has(f.id));
      selectAllEl.checked = allSel;
      selectAllEl.indeterminate = someSel && !allSel;
    }
    if (fixBtn) fixBtn.disabled = this.selected.size === 0;
  }

  openFinding(finding: any): void {
    if (finding.type === 'comment' && finding.path) {
      vscode.postMessage({ type: 'openPRComment', filePath: finding.path, line: finding.line || 1, author: finding.author, body: finding.body, source: finding.source });
    } else if (finding.type === 'alert' && finding.file) {
      vscode.postMessage({ type: 'openPRComment', filePath: finding.file, line: 1, author: 'Security', body: '[' + (finding.severity || '').toUpperCase() + '] ' + finding.description, source: 'codeql' });
    } else if (finding.type === 'check' && finding.url) {
      vscode.postMessage({ type: 'openExternal', url: finding.url });
    }
  }

  render(): void {
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

    container.innerHTML = filtered.map(f => this._renderItem(f)).join('');
    this._wireEvents(container);
    this.updateToolbar();
  }

  _wireEvents(container: HTMLElement): void {
    const self = this;
    container.querySelectorAll('.pending-action-checkbox').forEach(el => {
      el.addEventListener('change', () => {
        const id = (el as HTMLElement).closest('.pending-action-item')?.getAttribute('data-id');
        if (id) self.toggleSelect(id);
      });
    });
    container.querySelectorAll('.pending-action-location').forEach(el => {
      el.addEventListener('click', e => {
        e.preventDefault();
        const url = (el as HTMLElement).getAttribute('data-url');
        if (url) { vscode.postMessage({ type: 'openExternal', url }); return; }
        const id = (el as HTMLElement).getAttribute('data-finding-id');
        if (id) {
          const finding = self.findings.find((f: any) => f.id === id);
          if (finding) self.openFinding(finding);
        }
      });
    });
    container.querySelectorAll('.md-link').forEach(el => {
      el.addEventListener('click', e => {
        e.preventDefault();
        const url = (el as HTMLElement).getAttribute('data-url');
        if (url) vscode.postMessage({ type: 'openExternal', url });
      });
    });
  }

  _renderItem(finding: any): string {
    const isChecked = this.selected.has(finding.id) ? 'checked' : '';
    const resolvedClass = finding.resolved ? ' resolved' : '';
    const processingClass = (finding.aiStatus === 'queued' || finding.aiStatus === 'processing') ? ' processing' : '';

    let aiStatusBadge = '';
    if (finding.aiStatus === 'queued') aiStatusBadge = '<span class="pending-action-ai-status queued">\u23F3 Queued</span>';
    else if (finding.aiStatus === 'processing') aiStatusBadge = '<span class="pending-action-ai-status processing"><span class="ai-spinner"></span> Processing</span>';
    else if (finding.aiStatus === 'fixed') aiStatusBadge = '<span class="pending-action-ai-status fixed">\u2705 Fixed</span>';
    else if (finding.aiStatus === 'failed') aiStatusBadge = '<span class="pending-action-ai-status failed">\u274C Failed</span>';

    let badge = '', metaInfo = '', locationHtml = '', bodyText = '';

    if (finding.type === 'comment') {
      badge = '<span class="pending-action-type-badge comment">Comment</span>';
      metaInfo = '<span class="pending-action-author">' + escapeHtml(finding.author || '') + '</span>'
        + '<span class="pending-action-source">' + escapeHtml(finding.source || '') + '</span>';
      bodyText = mdLinks(truncate(finding.body || '', 300));
      if (finding.path) {
        locationHtml = '<a class="pending-action-location" href="#" data-finding-id="' + finding.id + '" title="Open in editor">'
          + '\ud83d\udcc4 ' + escapeHtml(finding.path) + (finding.line ? ':' + finding.line : '') + '</a>';
      }
      if (finding.url) {
        locationHtml += ' <a class="pending-action-location external-link" href="#" data-url="' + escapeHtml(finding.url) + '" title="View comment on GitHub">'
          + '\ud83d\udd17 View comment</a>';
      }
    } else if (finding.type === 'check') {
      badge = '<span class="pending-action-type-badge check">CI Check</span>';
      metaInfo = '<span class="pending-action-author">' + escapeHtml(finding.name || '') + '</span>';
      bodyText = 'Check is failing';
      if (finding.url) {
        locationHtml = '<a class="pending-action-location" href="#" data-finding-id="' + finding.id + '" title="View check details">'
          + '\ud83d\udd17 View details</a>';
      }
    } else if (finding.type === 'alert') {
      badge = '<span class="pending-action-type-badge alert">Security</span>';
      const sev = (finding.severity || 'medium').toLowerCase();
      metaInfo = '<span class="pending-action-severity ' + sev + '">' + sev.toUpperCase() + '</span>';
      bodyText = escapeHtml(finding.description || '');
      if (finding.file) {
        locationHtml = '<a class="pending-action-location" href="#" data-finding-id="' + finding.id + '" title="Open in editor">'
          + '\ud83d\udcc4 ' + escapeHtml(finding.file) + '</a>';
      }
    }

    // Render nested reply chips for comment threads
    let repliesHtml = '';
    if (finding.type === 'comment' && finding.replies?.length) {
      repliesHtml = '<div class="thread-replies">'
        + finding.replies.map((r: any) => {
          const replyBody = truncate(r.body || '', 120);
          return '<div class="thread-reply">'
            + '<span class="reply-connector">\u2514\u2500</span>'
            + '<span class="reply-author">\uD83D\uDCAC ' + escapeHtml(r.author || '') + '</span> '
            + '<span class="reply-body">' + escapeHtml(replyBody) + '</span>'
            + '</div>';
        }).join('')
        + '</div>';
    }

    const isLocked = finding.aiStatus === 'queued' || finding.aiStatus === 'processing';
    const disabledAttr = isLocked ? ' disabled' : '';

    return '<div class="pending-action-item' + resolvedClass + processingClass + '" data-type="' + finding.type + '" data-id="' + finding.id + '">'
      + '<input type="checkbox" class="pending-action-checkbox" ' + isChecked + disabledAttr + ' />'
      + '<div class="pending-action-body">'
      + '<div class="pending-action-meta">' + badge + metaInfo + aiStatusBadge + '</div>'
      + '<div class="pending-action-text">' + bodyText + '</div>'
      + repliesHtml
      + (locationHtml ? '<div>' + locationHtml + '</div>' : '')
      + '</div></div>';
  }
}

/* ── Action Log Control ──────────────────────────────────────────────── */

class ActionLogControl {
  actions: any[];
  constructor() { this.actions = []; this.render(); }

  addAction(action: any): void { this.actions.unshift(action); this.render(); }

  render(): void {
    const container = document.getElementById('action-log-entries');
    if (!container) return;

    if (this.actions.length === 0) {
      container.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 11px;">No actions taken yet. Use "Fix with AI" on pending findings to start.</div>';
      return;
    }

    container.innerHTML = this.actions.map(action => {
      const icon = action.success
        ? (action.type === 'fix-code' ? '\u2699\uFE0F' : action.type === 'respond-comment' ? '\uD83D\uDCAC' : '\u2705')
        : '\u274C';
      const statusClass = action.success ? 'success' : 'failed';

      let statusText = 'Done';
      if (!action.success) statusText = 'Failed';
      else if (action.type === 'fix-code' && action.commitHash) statusText = 'Pushed';
      else if (action.type === 'fix-code') statusText = 'Applied';
      else if (action.type === 'respond-comment') statusText = 'Replied';

      const timestamp = new Date(action.timestamp || Date.now()).toLocaleTimeString();
      const commitInfo = action.commitHash
        ? '<span class="action-commit">' + action.commitHash.substring(0, 7) + '</span>' : '';

      const clickableClass = action.sessionId ? ' clickable' : '';
      const sessionAttr = action.sessionId ? ' data-session-id="' + action.sessionId + '"' : '';
      const consoleLink = action.sessionId ? '<span class="action-console-link">View Console \u25B6</span>' : '';
      const commentLink = action.commentUrl
        ? '<a class="action-comment-link" href="#" data-url="' + action.commentUrl + '">View Comment \u2197</a>' : '';

      return '<div class="action-entry ' + action.type + ' ' + statusClass + clickableClass + '"' + sessionAttr + '>'
        + '<div class="action-icon">' + icon + '</div>'
        + '<div class="action-content">'
        + '<div class="action-type">' + action.description
        + '<span class="action-status ' + statusClass + '">' + statusText + '</span>'
        + commitInfo + consoleLink + commentLink + '</div>'
        + '<div class="action-timestamp">' + timestamp + '</div>'
        + '</div></div>';
    }).join('');

    container.querySelectorAll('.action-entry.clickable').forEach(entry => {
      entry.addEventListener('click', e => {
        if ((e.target as HTMLElement).closest('.action-comment-link')) return;
        const sid = (entry as HTMLElement).getAttribute('data-session-id');
        if (sid && cliConsole) {
          cliConsole.expandedSession = sid;
          cliConsole.render();
          const section = document.getElementById('cli-console-section');
          if (section) { section.style.display = 'block'; section.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        }
      });
    });
    container.querySelectorAll('.action-comment-link').forEach(link => {
      link.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        const url = (link as HTMLElement).getAttribute('data-url');
        if (url) vscode.postMessage({ type: 'openExternal', url });
      });
    });
  }
}

/* ── CLI Console Control ─────────────────────────────────────────────── */

class CliConsoleControl {
  sessions: any[];
  expandedSession: string | null;

  constructor() { this.sessions = []; this.expandedSession = null; this.render(); }

  startSession(sessionId: string, label: string): void {
    this.sessions.unshift({ id: sessionId, label: label || 'Copilot CLI', lines: [] as string[], active: true, startTime: Date.now() });
    this.expandedSession = sessionId;
    this.render();
  }

  appendLine(sessionId: string, line: string): void {
    const session = this.sessions.find((s: any) => s.id === sessionId);
    if (!session) return;
    session.lines.push(line);
    if (this.expandedSession === sessionId) this._appendToConsole(line);
  }

  endSession(sessionId: string, success: boolean): void {
    const session = this.sessions.find((s: any) => s.id === sessionId);
    if (session) { session.active = false; session.success = success; session.endTime = Date.now(); }
    this.render();
  }

  /** Called on each pulse event to update elapsed time labels for active sessions. */
  tickElapsed(): void {
    for (const s of this.sessions) {
      if (!s.active || !s.startTime) continue;
      const ms = Date.now() - s.startTime;
      const sec = Math.floor(ms / 1000);
      const text = sec < 60 ? sec + 's' : Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
      const tab = document.querySelector(`.cli-session-tab[data-session-id="${s.id}"] .cli-elapsed`);
      if (tab) tab.textContent = text;
    }
  }

  _appendToConsole(line: string): void {
    const pre = document.getElementById('cli-console-output');
    if (!pre) return;
    const lineEl = document.createElement('div');
    lineEl.className = 'cli-line';
    lineEl.textContent = line;
    pre.appendChild(lineEl);
    pre.scrollTop = pre.scrollHeight;
  }

  render(): void {
    const container = document.getElementById('cli-console-section');
    if (!container) return;
    if (this.sessions.length === 0) { container.style.display = 'none'; return; }
    container.style.display = 'block';

    const header = document.getElementById('cli-console-header');
    const body = document.getElementById('cli-console-body');
    if (!header || !body) return;

    const self = this;
    header.innerHTML = this.sessions.map(s => {
      const statusIcon = s.active ? '<span class="ai-spinner"></span>' : (s.success ? '\u2705' : '\u274C');
      const selected = self.expandedSession === s.id ? ' selected' : '';
      let elapsed = '';
      if (s.startTime) {
        const ms = (s.endTime || Date.now()) - s.startTime;
        const sec = Math.floor(ms / 1000);
        elapsed = sec < 60 ? sec + 's' : Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
      }
      return '<button class="cli-session-tab' + (s.active ? ' active' : '') + selected + '" data-session-id="' + s.id + '">'
        + statusIcon + ' ' + s.label + ' <span class="cli-elapsed">' + elapsed + '</span></button>';
    }).join('');

    header.querySelectorAll('.cli-session-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        self.expandedSession = (tab as HTMLElement).getAttribute('data-session-id');
        self.render();
      });
    });

    const session = this.sessions.find((s: any) => s.id === self.expandedSession);
    if (session) {
      body.innerHTML = '<pre class="cli-console-output" id="cli-console-output"></pre>';
      const pre = document.getElementById('cli-console-output');
      if (pre) {
        session.lines.forEach((line: string) => {
          const lineEl = document.createElement('div');
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

/* ── Message Router ──────────────────────────────────────────────────── */

function setupMessageListener(): void {
  window.addEventListener('message', event => {
    const message = event.data;
    switch (message.type) {
      case 'gitAccount':
        updateGitAccountDisplay(message.username);
        break;
      case 'pulse':
        if (cliConsole) cliConsole.tickElapsed();
        break;
      case 'taskUpdate':
        if (prepTasks && message.taskId) prepTasks.updateTask(message.taskId, message.status, message.error);
        break;
      case 'taskOutput':
        if (prepTasks && message.taskId && message.line) prepTasks.appendLogLine(message.taskId, message.line);
        break;
      case 'mergeProgress':
        if (mergeProgress) mergeProgress.update(message.results);
        break;
      case 'prUpdate':
        if (prMonitor) prMonitor.update(message.stats);
        break;
      case 'cycleCompleted':
        if (prMonitor && message.cycle) prMonitor.addCycle(message.cycle);
        if (pendingActions && message.cycle) pendingActions.updateFromCycle(message.cycle);
        break;
      case 'actionTaken':
        if (actionLog) actionLog.addAction(message.action);
        break;
      case 'findingsResolved':
        if (pendingActions && message.findingIds) pendingActions.markResolved(message.findingIds);
        break;
      case 'findingsProcessing':
        if (pendingActions && message.findingIds) pendingActions.setProcessing(message.findingIds, message.status);
        break;
      case 'monitoringStopped':
        if (prMonitor) prMonitor.onStopped();
        break;
      case 'cliSessionStart':
        if (cliConsole && message.sessionId) cliConsole.startSession(message.sessionId, message.label);
        break;
      case 'cliSessionOutput':
        if (cliConsole && message.sessionId) cliConsole.appendLine(message.sessionId, message.line);
        break;
      case 'cliSessionEnd':
        if (cliConsole && message.sessionId) cliConsole.endSession(message.sessionId, message.success);
        break;
    }
  });
}

/* ── Initialization ──────────────────────────────────────────────────── */

function initControls(): void {
  if (releaseData.status === 'drafting') {
    if (releaseData.flowType === 'from-plans') {
      planSelector = new PlanSelectorControl('plan-list');
    } else {
      optionalPlanSelector = new PlanSelectorControl('optional-plan-list');
    }
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

    if (releaseData.lastCycle) {
      prMonitor.addCycle(releaseData.lastCycle);
      pendingActions.updateFromCycle(releaseData.lastCycle);
      if (releaseData.monitoringStats) {
        prMonitor.update({
          checksPass: releaseData.monitoringStats.checksPass || 0,
          checksFail: releaseData.monitoringStats.checksFail || 0,
          unresolvedThreads: releaseData.monitoringStats.unresolvedThreads || 0,
          unresolvedAlerts: releaseData.monitoringStats.unresolvedAlerts || 0,
        });
      }
    }

    if (releaseData.actionLog?.length) {
      const reversedLog = releaseData.actionLog.slice().reverse();
      for (const entry of reversedLog) actionLog.addAction(entry);
    }

    const selectAllCb = document.getElementById('pending-select-all');
    if (selectAllCb && pendingActions) {
      selectAllCb.addEventListener('change', () => pendingActions!.selectAll());
    }
    const fixAiBtn = document.getElementById('pending-fix-ai-btn');
    if (fixAiBtn) {
      fixAiBtn.addEventListener('click', () => addressSelectedWithAI());
    }
  }
}

/**
 * Main entry point called from the inline data-injection script.
 *
 * @param config.releaseData - Serialized release definition
 * @param config.availablePlans - Available plan summaries
 */
export function initReleasePanel(config: { releaseData: any; availablePlans: any[] }): void {
  vscode = acquireVsCodeApi();
  releaseData = config.releaseData;
  availablePlans = config.availablePlans;

  // Expose globals that HTML onclick attributes need
  const g = globalThis as any;
  g.proceedFromConfigure = proceedFromConfigure;
  g.executeTask = executeTask;
  g.skipTask = skipTask;
  g.markTaskComplete = markTaskComplete;
  g.retryTask = retryTask;
  g.createPR = createPR;
  g.adoptPR = adoptPR;
  g.startMonitoring = startMonitoring;
  g.pauseMonitoring = pauseMonitoring;
  g.stopMonitoring = stopMonitoring;
  g.openPlanSelector = openPlanSelector;
  g.cancelRelease = cancelRelease;
  g.deleteRelease = deleteRelease;
  g.retryRelease = retryRelease;
  g.scaffoldTaskFiles = scaffoldTaskFiles;
  g.refresh = refresh;
  g.viewTaskLog = viewTaskLog;
  g.acknowledgeFinding = acknowledgeFinding;
  g.dismissFinding = dismissFinding;
  g.openFindingFile = openFindingFile;
  g.switchAccount = switchAccount;
  g.filterPendingActions = filterPendingActions;
  g.addressSelectedWithAI = addressSelectedWithAI;
  g.planSelector = undefined; // Will be set by initControls

  initControls();

  // Expose planSelector for onclick refs after init
  g.planSelector = planSelector;
  g.optionalPlanSelector = optionalPlanSelector;

  setupMessageListener();
}
