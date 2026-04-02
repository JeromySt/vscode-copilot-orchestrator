/**
 * @fileoverview Attempt card control — manages attempt history card list.
 *
 * Subscribes to {@link Topics.ATTEMPT_UPDATE} and rebuilds the attempt card
 * list with current status, duration, metrics, and expand/collapse state.
 *
 * @module ui/webview/controls/attemptCard
 */

import { EventBus } from '../eventBus';
import { SubscribableControl } from '../subscribableControl';
import { Topics } from '../topics';

/** Single attempt data from the backend. */
export interface AttemptCardData {
  attemptNumber: number;
  status: string;
  triggerType?: string;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  failedPhase?: string;
  exitCode?: number;
  copilotSessionId?: string;
  stepStatuses?: Record<string, string>;
  worktreePath?: string;
  baseCommit?: string;
  logFilePath?: string;
  workUsedHtml?: string;
  prechecksUsedHtml?: string;
  postchecksUsedHtml?: string;
  logs?: string;
  metricsHtml?: string;
  expanded?: boolean;
}

/** Batch update payload from the backend. */
interface AttemptUpdatePayload {
  attempts: AttemptCardData[];
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncateLogPath(filePath: string): string {
  if (!filePath) { return ''; }
  const separator = filePath.includes('\\') ? '\\' : '/';
  const parts = filePath.split(separator);
  const filename = parts[parts.length - 1];
  const prefix = parts[0] + separator;

  let truncatedFilename = filename;
  const logMatch = filename.match(/^([a-f0-9]{8})-[a-f0-9-]+_[a-f0-9-]+-([a-f0-9]{12})_(\d+\.log)$/i);
  if (logMatch) {
    truncatedFilename = logMatch[1] + '....' + logMatch[2] + '_' + logMatch[3];
  }

  if (filePath.length <= 50) { return filePath; }
  return prefix + '....' + separator + truncatedFilename;
}

function formatDuration(sec: number): string {
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return m + 'm ' + s + 's';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}

function stepIconHtml(status?: string): string {
  const icon = status === 'success' || status === 'succeeded' ? '✓'
    : status === 'failed' ? '✗'
    : status === 'running' ? '⟳'
    : status === 'skipped' ? '⊘'
    : '○';
  const cls = status === 'success' || status === 'succeeded' ? 'success'
    : status === 'failed' ? 'failed'
    : status === 'running' ? 'running'
    : status === 'skipped' ? 'skipped'
    : 'pending';
  return '<span class="step-icon ' + cls + '">' + icon + '</span>';
}

/**
 * Attempt card list control — manages the entire attempt history container.
 */
export class AttemptCard extends SubscribableControl {
  private selector: string;
  private expandedAttempts = new Set<number>();

  constructor(bus: EventBus, controlId: string, selector: string) {
    super(bus, controlId);
    this.selector = selector;
    this.subscribe(Topics.ATTEMPT_UPDATE, (data?: AttemptUpdatePayload) => {
      if (data?.attempts) this.rebuild(data.attempts);
    });
  }

  /** Rebuild the entire attempt card list from fresh data. */
  private rebuild(attempts: AttemptCardData[]): void {
    const container = document.querySelector(this.selector) as HTMLElement | null;
    if (!container) return;

    // Preserve expanded state
    container.querySelectorAll('.attempt-card[data-expanded="true"]').forEach(el => {
      const num = parseInt(el.getAttribute('data-attempt') || '0', 10);
      if (num) this.expandedAttempts.add(num);
    });

    // Build HTML — latest first
    const sorted = attempts.slice().sort((a, b) => b.attemptNumber - a.attemptNumber);
    const html = sorted.map(att => this.renderCard(att)).join('');
    container.innerHTML = '<div class="section"><h3>Attempt History (' + attempts.length + ')</h3>' + html + '</div>';

    // Wire up click handlers for expand/collapse
    container.querySelectorAll('.attempt-header').forEach(header => {
      header.addEventListener('click', () => {
        const card = header.closest('.attempt-card') as HTMLElement | null;
        if (!card) return;
        const num = parseInt(card.getAttribute('data-attempt') || '0', 10);
        const body = card.querySelector('.attempt-body') as HTMLElement | null;
        const isExpanded = header.getAttribute('data-expanded') === 'true';
        if (body) body.style.display = isExpanded ? 'none' : 'block';
        header.setAttribute('data-expanded', isExpanded ? 'false' : 'true');
        card.setAttribute('data-expanded', isExpanded ? 'false' : 'true');
        if (isExpanded) this.expandedAttempts.delete(num);
        else this.expandedAttempts.add(num);
      });
    });

    // Wire up attempt phase tab clicks
    container.querySelectorAll('.attempt-phase-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const btn = e.currentTarget as HTMLElement;
        const phase = btn.getAttribute('data-phase');
        const attNum = btn.getAttribute('data-attempt');
        if (!phase || !attNum) return;
        // Update active tab
        const tabBar = btn.closest('.attempt-phase-tabs');
        if (tabBar) tabBar.querySelectorAll('.attempt-phase-tab').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        // Swap log content
        const card = btn.closest('.attempt-card');
        if (!card) return;
        const dataEl = card.querySelector('.attempt-logs-data[data-attempt="' + attNum + '"]') as HTMLElement | null;
        const viewer = card.querySelector('.attempt-log-viewer[data-attempt="' + attNum + '"]') as HTMLElement | null;
        if (dataEl && viewer) {
          try {
            const allLogs = JSON.parse(dataEl.textContent || '{}');
            viewer.textContent = allLogs[phase] || '(no logs for this phase)';
          } catch { /* ignore parse errors */ }
        }
      });
    });
  }

  /** Render a single attempt card. */
  private renderCard(att: AttemptCardData): string {
    const isRunning = att.status === 'running';
    const duration = att.startedAt
      ? (isRunning
        ? formatDuration(Math.round((Date.now() - att.startedAt) / 1000)) + '\u2026'
        : formatDuration(Math.round(((att.endedAt || Date.now()) - att.startedAt) / 1000)))
      : '--';
    const timestamp = att.startedAt ? new Date(att.startedAt).toLocaleString() : '';

    const statusColor = att.status === 'succeeded' ? '#4ec9b0'
      : att.status === 'failed' ? '#f48771'
      : att.status === 'running' ? '#3794ff'
      : '#858585';
    const statusIcon = att.status === 'succeeded' ? '\u2713'
      : att.status === 'failed' ? '\u2717'
      : att.status === 'running' ? '\u25B6'
      : '\u2298';

    const triggerLabel = att.triggerType === 'auto-heal' ? '\uD83D\uDD27 Auto-Heal'
      : att.triggerType === 'retry' ? '\uD83D\uDD04 Retry'
      : att.triggerType === 'postchecks-revalidation' ? '\uD83D\uDD0D Re-validation'
      : '';
    const triggerBadge = triggerLabel ? '<span class="attempt-trigger-badge">' + triggerLabel + '</span>' : '';

    const ss = att.stepStatuses || {};
    const stepIndicators = '<span class="step-indicators">'
      + stepIconHtml(ss['merge-fi'])
      + stepIconHtml(ss['prechecks'])
      + stepIconHtml(ss['work'])
      + stepIconHtml(ss['commit'])
      + stepIconHtml(ss['postchecks'])
      + stepIconHtml(ss['merge-ri'])
      + '</span>';

    const expanded = this.expandedAttempts.has(att.attemptNumber);
    const bodyDisplay = expanded ? 'block' : 'none';

    // ── Error section ──
    const errorHtml = att.error
      ? '<div class="attempt-section attempt-error-section">'
        + '<div class="attempt-section-title">\u274C Error</div>'
        + '<div class="attempt-error-body">'
        + '<div class="attempt-error-msg">' + escapeHtml(att.error) + '</div>'
        + (att.failedPhase ? '<div class="attempt-error-detail">Failed in phase: <strong>' + escapeHtml(att.failedPhase) + '</strong></div>' : '')
        + (att.exitCode !== undefined ? '<div class="attempt-error-detail">Exit code: <strong>' + att.exitCode + '</strong></div>' : '')
        + '</div></div>'
      : '';

    // ── Metrics section ──
    const metricsHtml = att.metricsHtml
      ? '<div class="attempt-section"><div class="attempt-section-title">\uD83D\uDCCA AI Usage</div>' + att.metricsHtml + '</div>'
      : '';

    // ── Context section ──
    const ctxItems: string[] = [];
    if (att.baseCommit) {
      ctxItems.push('<div class="attempt-ctx-row"><span class="attempt-ctx-label">Base</span><code class="attempt-ctx-value">' + att.baseCommit.slice(0, 8) + '</code></div>');
    }
    if (att.worktreePath) {
      ctxItems.push('<div class="attempt-ctx-row"><span class="attempt-ctx-label">Worktree</span><code class="attempt-ctx-value">' + escapeHtml(att.worktreePath) + '</code></div>');
    }
    if (att.logFilePath) {
      ctxItems.push('<div class="attempt-ctx-row"><span class="attempt-ctx-label">Log</span><span class="log-file-path attempt-ctx-value" data-path="' + escapeHtml(att.logFilePath) + '" title="' + escapeHtml(att.logFilePath) + '">\uD83D\uDCC4 ' + escapeHtml(truncateLogPath(att.logFilePath)) + '</span></div>');
    }
    if (att.copilotSessionId) {
      ctxItems.push('<div class="attempt-ctx-row"><span class="attempt-ctx-label">Session</span><span class="session-id attempt-ctx-value" data-session="' + escapeHtml(att.copilotSessionId) + '" title="Click to copy">' + escapeHtml(att.copilotSessionId.substring(0, 12)) + '\u2026 \uD83D\uDCCB</span></div>');
    }
    const contextHtml = ctxItems.length > 0
      ? '<div class="attempt-section"><div class="attempt-section-title">\uD83D\uDD17 Context</div><div class="attempt-ctx-grid">' + ctxItems.join('') + '</div></div>'
      : '';

    // ── Specs sections ──
    const prechecksHtml = att.prechecksUsedHtml
      ? '<div class="attempt-section"><div class="attempt-section-title">\uD83D\uDD0D Prechecks</div>' + att.prechecksUsedHtml + '</div>'
      : '';
    const workHtml = att.workUsedHtml
      ? '<div class="attempt-section"><div class="attempt-section-title">\uD83D\uDCDD Work Spec</div>' + att.workUsedHtml + '</div>'
      : '';
    const postchecksHtml = att.postchecksUsedHtml
      ? '<div class="attempt-section"><div class="attempt-section-title">\u2705 Postchecks</div>' + att.postchecksUsedHtml + '</div>'
      : '';

    // ── Log section with phase tabs ──
    let logSection = '';
    if (att.logs) {
      const phases = ['all', 'merge-fi', 'prechecks', 'work', 'commit', 'postchecks', 'merge-ri'];
      const phaseLabels: Record<string, string> = {
        'all': '\uD83D\uDCC4 Full Log',
        'merge-fi': '\u21D9\u21D8 Merge FI',
        'prechecks': '\u2713 Prechecks',
        'work': '\u2699 Work',
        'commit': '\uD83D\uDCBE Commit',
        'postchecks': '\u2713 Postchecks',
        'merge-ri': '\u2197\u2199 Merge RI',
      };
      const phaseLogs = this.extractPhaseLogs(att.logs, phases);
      // Also include the full log
      phaseLogs['all'] = att.logs;

      const tabsHtml = phases.map(p => {
        const ss2 = att.stepStatuses || {};
        const pStatus = p === 'all' ? '' : (ss2[p] || '');
        const statusCls = pStatus === 'success' || pStatus === 'succeeded' ? ' success'
          : pStatus === 'failed' ? ' failed'
          : pStatus === 'skipped' ? ' skipped'
          : '';
        return '<button class="attempt-phase-tab' + (p === 'all' ? ' active' : '') + statusCls + '" data-phase="' + p + '" data-attempt="' + att.attemptNumber + '">'
          + (phaseLabels[p] || p) + '</button>';
      }).join('');

      logSection = '<div class="attempt-section"><div class="attempt-section-title">\uD83D\uDCCB Logs</div>'
        + '<div class="attempt-phases" data-attempt="' + att.attemptNumber + '">'
        + '<div class="attempt-phase-tabs">' + tabsHtml + '</div>'
        + '<pre class="attempt-log-viewer" data-attempt="' + att.attemptNumber + '">' + escapeHtml(phaseLogs['all'] || '') + '</pre>'
        + '<script type="application/json" class="attempt-logs-data" data-attempt="' + att.attemptNumber + '">'
        + JSON.stringify(phaseLogs)
        + '<\/script>'
        + '</div></div>';
    }

    // ── Running placeholder ──
    const hasBodyContent = errorHtml || metricsHtml || ctxItems.length > 0 || prechecksHtml || workHtml || postchecksHtml || logSection;
    const runningPlaceholder = (!hasBodyContent && isRunning)
      ? '<div class="attempt-section"><div class="attempt-running-indicator">\u27F3 Executing\u2026 see live log viewer above for current output.</div></div>'
      : '';

    return '<div class="attempt-card" data-attempt="' + att.attemptNumber + '" data-expanded="' + expanded + '" style="border-left: 3px solid ' + statusColor + ';">'
      + '<div class="attempt-header" data-expanded="' + expanded + '">'
      + '<div class="attempt-header-left">'
      + '<span class="attempt-status-icon" style="color:' + statusColor + ';">' + statusIcon + '</span>'
      + '<span class="attempt-badge">#' + att.attemptNumber + '</span>'
      + triggerBadge
      + stepIndicators
      + '</div>'
      + '<div class="attempt-header-right">'
      + '<span class="attempt-time">' + timestamp + '</span>'
      + '<span class="attempt-duration">' + duration + '</span>'
      + '<span class="attempt-chevron">\u203A</span>'
      + '</div>'
      + '</div>'
      + '<div class="attempt-body" style="display:' + bodyDisplay + ';">'
      + runningPlaceholder + errorHtml + metricsHtml + contextHtml + prechecksHtml + workHtml + postchecksHtml + logSection
      + '</div>'
      + '</div>';
  }

  /** Extract phase-specific logs from the combined log content. */
  private extractPhaseLogs(logs: string, phases: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    const markerMap: Record<string, [string, string]> = {
      'merge-fi': ['FORWARD INTEGRATION', 'FORWARD INTEGRATION'],
      'prechecks': ['PRECHECKS SECTION START', 'PRECHECKS SECTION END'],
      'work': ['WORK SECTION START', 'WORK SECTION END'],
      'commit': ['COMMIT SECTION START', 'COMMIT SECTION END'],
      'postchecks': ['POSTCHECKS SECTION START', 'POSTCHECKS SECTION END'],
      'merge-ri': ['REVERSE INTEGRATION', 'REVERSE INTEGRATION'],
    };
    for (const phase of phases) {
      const markers = markerMap[phase];
      if (!markers) continue;
      const startIdx = logs.indexOf(markers[0]);
      if (startIdx === -1) continue;
      const endIdx = logs.indexOf(markers[1], startIdx + markers[0].length);
      if (endIdx !== -1) {
        result[phase] = logs.substring(startIdx, endIdx + markers[1].length + 20).trim();
      } else {
        // Running phase — take everything from start marker onwards
        result[phase] = logs.substring(startIdx).trim();
      }
    }
    return result;
  }

  // Legacy methods for compatibility
  update(data?: AttemptCardData): void {
    // No-op — rebuild() handles all updates now
  }

  expand(): void {
    // No-op — managed by rebuild click handlers
  }

  collapse(): void {
    // No-op — managed by rebuild click handlers
  }

  toggle(): void {
    // No-op — managed by rebuild click handlers
  }

  isExpanded(): boolean {
    return false;
  }
}
