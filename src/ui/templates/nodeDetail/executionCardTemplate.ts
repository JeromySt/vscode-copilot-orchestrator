/**
 * @fileoverview Shared execution card template — single source of truth for rendering
 * execution data across the main view and attempt history cards.
 *
 * Used by both:
 * 1. `nodeDetailPanel.ts` (live main view via `isLive: true`)
 * 2. `attemptsTemplate.ts` (historical attempt cards via `isLive: false`)
 * 3. `attemptCard.ts` (CSR attempt card control, mirrors this structure)
 *
 * @module ui/templates/nodeDetail/executionCardTemplate
 */

import { escapeHtml } from '../helpers';
import {
  formatDurationSeconds,
  formatTokenCount,
  formatPremiumRequests,
  formatCodeChanges,
} from '../../../plan/metricsAggregator';

/** Model usage breakdown entry for metrics display. */
export interface ExecutionCardModelBreakdown {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  premiumRequests?: number;
}

/** Input data for an execution card (live or historical). */
export interface ExecutionCardData {
  attemptNumber: number;
  /** 'running' | 'succeeded' | 'failed' | 'canceled' | 'crashed' | etc. */
  status: string;
  triggerType?: string;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  failureReason?: string;
  /** Phase name that failed (e.g. 'work', 'postchecks'). */
  lastPhase?: string;
  exitCode?: number;
  stepStatuses?: Record<string, string>;
  metrics?: {
    premiumRequests?: number;
    apiTimeSeconds?: number;
    sessionTimeSeconds?: number;
    codeChanges?: { linesAdded: number; linesRemoved: number };
    modelBreakdown?: ExecutionCardModelBreakdown[];
  };
  copilotSessionId?: string;
  baseCommit?: string;
  worktreePath?: string;
  logFilePath?: string;
  /** Phase → log content map (pre-split). Use `splitAttemptLogs` to populate. */
  logs?: Record<string, string>;
  /** true = main view (live updates, always expanded), false = historical attempt body */
  isLive?: boolean;
  /** Task description */
  task?: string;
  /** Pre-rendered work spec HTML (markdown rendered to HTML) */
  workSpecHtml?: string;
}

const PHASE_ORDER = ['merge-fi', 'setup', 'prechecks', 'work', 'commit', 'postchecks', 'merge-ri'] as const;

// ─── Icon helpers ─────────────────────────────────────────────────────────────

function phaseIconChar(status?: string): string {
  if (status === 'success' || status === 'succeeded') { return '\u2713'; }  // ✓
  if (status === 'failed') { return '\u2717'; }   // ✗
  if (status === 'running') { return '\u27F3'; }  // ⟳
  if (status === 'skipped') { return '\u2298'; }  // ⊘
  return '\u2022';                                // • (pending)
}

function phaseStatusClass(status?: string): string {
  if (status === 'success' || status === 'succeeded') { return 'success'; }
  if (status === 'failed') { return 'failed'; }
  if (status === 'running') { return 'running'; }
  if (status === 'skipped') { return 'skipped'; }
  return 'pending';
}

function stepIconHtml(status?: string): string {
  return '<span class="step-icon ' + phaseStatusClass(status) + '">' + phaseIconChar(status) + '</span>';
}

// ─── Log path truncation ───────────────────────────────────────────────────────

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

// ─── Public section renderers ─────────────────────────────────────────────────

/**
 * Render the phase step-icon bar (six icons, one per phase).
 * Used in attempt card headers and the live execution card.
 *
 * @param stepStatuses - Phase-to-status mapping.
 * @param _isRunning - Whether the node is currently running (reserved for future use).
 * @returns HTML string containing six `.step-icon` spans.
 */
export function phaseTabsHtml(stepStatuses: Record<string, string>, _isRunning: boolean): string {
  return PHASE_ORDER.map(p => stepIconHtml(stepStatuses[p])).join('');
}

/**
 * Render the AI usage metrics section content (inner card only, no `.attempt-section` wrapper).
 *
 * @param metrics - Raw metrics data.
 * @returns HTML string for an `.attempt-metrics-card`, or empty string if no data.
 */
export function metricsHtml(metrics: ExecutionCardData['metrics']): string {
  if (!metrics) { return ''; }

  const stats: string[] = [];

  if (metrics.premiumRequests !== undefined) {
    stats.push('<div class="metrics-stat">\uD83C\uDFAB ' + formatPremiumRequests(metrics.premiumRequests) + '</div>');
  }
  if (metrics.apiTimeSeconds !== undefined) {
    stats.push('<div class="metrics-stat">\u23F1 API: ' + formatDurationSeconds(metrics.apiTimeSeconds) + '</div>');
  }
  if (metrics.sessionTimeSeconds !== undefined) {
    stats.push('<div class="metrics-stat">\uD83D\uDD50 Session: ' + formatDurationSeconds(metrics.sessionTimeSeconds) + '</div>');
  }
  if (metrics.codeChanges) {
    stats.push('<div class="metrics-stat">\uD83D\uDCDD Code: ' + formatCodeChanges(metrics.codeChanges) + '</div>');
  }

  if (stats.length === 0 && (!metrics.modelBreakdown || metrics.modelBreakdown.length === 0)) {
    return '';
  }

  let modelHtml = '';
  if (metrics.modelBreakdown && metrics.modelBreakdown.length > 0) {
    const rows = metrics.modelBreakdown.map(b => {
      const cached = b.cachedTokens ? ', ' + formatTokenCount(b.cachedTokens) + ' cached' : '';
      const reqs = b.premiumRequests !== undefined ? ' (' + b.premiumRequests + ' req)' : '';
      return '<div class="model-row">'
        + '<span class="model-name">' + escapeHtml(b.model) + '</span>'
        + '<span class="model-tokens">' + formatTokenCount(b.inputTokens) + ' in, ' + formatTokenCount(b.outputTokens) + ' out' + cached + reqs + '</span>'
        + '</div>';
    }).join('');
    modelHtml = '<div class="model-breakdown">'
      + '<div class="model-breakdown-label">Model Breakdown:</div>'
      + '<div class="model-breakdown-list">' + rows + '</div>'
      + '</div>';
  }

  return '<div class="attempt-metrics-card">'
    + '<div class="metrics-stats-grid">' + stats.join('') + '</div>'
    + modelHtml
    + '</div>';
}

/**
 * Render the error section (`.attempt-section.attempt-error-section` block).
 *
 * @param error - Error message, or undefined/empty for no section.
 * @param failureReason - 'crashed' | 'failed' etc.
 * @param lastPhase - Phase name that failed.
 * @param exitCode - Process exit code if available.
 * @returns HTML string or empty string.
 */
export function errorHtml(
  error?: string,
  failureReason?: string,
  lastPhase?: string,
  exitCode?: number,
): string {
  if (!error) { return ''; }
  return '<div class="attempt-section attempt-error-section">'
    + '<div class="attempt-section-title">\u274C Error</div>'
    + '<div class="attempt-error-body">'
    + '<div class="attempt-error-msg">' + escapeHtml(error) + '</div>'
    + (lastPhase ? '<div class="attempt-error-detail">Failed in phase: <strong>' + escapeHtml(lastPhase) + '</strong></div>' : '')
    + (exitCode !== undefined ? '<div class="attempt-error-detail">Exit code: <strong>' + exitCode + '</strong></div>' : '')
    + '</div></div>';
}

/**
 * Render the context section (base commit, worktree, log path, session ID).
 *
 * @param data - Partial execution card data with optional context fields.
 * @returns HTML string or empty string.
 */
export function contextHtml(data: Partial<ExecutionCardData>): string {
  const items: string[] = [];

  if (data.baseCommit) {
    items.push('<div class="attempt-ctx-row">'
      + '<span class="attempt-ctx-label">Base</span>'
      + '<code class="attempt-ctx-value">' + data.baseCommit.slice(0, 8) + '</code>'
      + '</div>');
  }
  if (data.worktreePath) {
    items.push('<div class="attempt-ctx-row">'
      + '<span class="attempt-ctx-label">Worktree</span>'
      + '<code class="attempt-ctx-value">' + escapeHtml(data.worktreePath) + '</code>'
      + '</div>');
  }
  if (data.logFilePath) {
    items.push('<div class="attempt-ctx-row">'
      + '<span class="attempt-ctx-label">Log</span>'
      + '<span class="log-file-path attempt-ctx-value" data-path="' + escapeHtml(data.logFilePath) + '" title="' + escapeHtml(data.logFilePath) + '">'
      + '\uD83D\uDCC4 ' + escapeHtml(truncateLogPath(data.logFilePath))
      + '</span>'
      + '</div>');
  }
  if (data.copilotSessionId) {
    items.push('<div class="attempt-ctx-row">'
      + '<span class="attempt-ctx-label">Session</span>'
      + '<span class="session-id attempt-ctx-value" data-session="' + escapeHtml(data.copilotSessionId) + '" title="Click to copy">'
      + escapeHtml(data.copilotSessionId.substring(0, 12)) + '\u2026 \uD83D\uDCCB'
      + '</span>'
      + '</div>');
  }

  if (items.length === 0) { return ''; }

  return '<div class="attempt-section">'
    + '<div class="attempt-section-title">\uD83D\uDD17 Context</div>'
    + '<div class="attempt-ctx-grid">' + items.join('') + '</div>'
    + '</div>';
}

// ─── Log splitting helper ─────────────────────────────────────────────────────

/**
 * Render the work spec section (task + rendered markdown instructions).
 *
 * @param task - Task description string.
 * @param workSpecHtml - Pre-rendered work spec HTML (markdown → HTML).
 * @returns HTML string or empty string.
 */
function workSpecSectionHtml(task?: string, workSpecHtml?: string): string {
  if (!task && !workSpecHtml) { return ''; }
  let html = '<div class="attempt-section">'
    + '<div class="attempt-section-title">\uD83D\uDCDD Work Spec</div>';
  if (task) {
    html += '<div class="attempt-ctx-row">'
      + '<span class="attempt-ctx-label">Task</span>'
      + '<span class="attempt-ctx-value">' + escapeHtml(task) + '</span>'
      + '</div>';
  }
  if (workSpecHtml) {
    html += '<div class="work-spec-content">' + workSpecHtml + '</div>';
  }
  html += '</div>';
  return html;
}

/**
 * Split a combined log string into a phase-keyed map.
 *
 * Produces `{ all: fullLog, 'merge-fi': ..., 'prechecks': ..., ... }`.
 * Phases without detected log content are omitted from the result.
 *
 * @param logs - The full combined log string.
 * @returns Map of phase name → log content.
 */
export function splitAttemptLogs(logs: string): Record<string, string> {
  const result: Record<string, string> = { all: logs };
  const markerMap: Record<string, string> = {
    'merge-fi': 'MERGE-FI SECTION',
    'setup': 'SETUP SECTION',
    'prechecks': 'PRECHECKS SECTION',
    'work': 'WORK SECTION',
    'commit': 'COMMIT SECTION',
    'postchecks': 'POSTCHECKS SECTION',
    'merge-ri': 'MERGE-RI SECTION',
  };

  for (const phase of PHASE_ORDER) {
    const marker = markerMap[phase];
    if (!marker) { continue; }
    const startIdx = logs.indexOf(marker);
    if (startIdx === -1) { continue; }
    const endIdx = logs.indexOf(marker, startIdx + marker.length);
    if (endIdx !== -1) {
      result[phase] = logs.substring(startIdx, endIdx + marker.length + 20).trim();
    } else {
      result[phase] = logs.substring(startIdx).trim();
    }
  }

  return result;
}

// ─── Logs section renderer ────────────────────────────────────────────────────

function logsSectionHtml(logs: Record<string, string>, attemptNumber: number): string {
  const phases = ['all', 'merge-fi', 'setup', 'prechecks', 'work', 'commit', 'postchecks', 'merge-ri'];
  const phaseLabels: Record<string, string> = {
    'all': '\uD83D\uDCC4 Full Log',
    'merge-fi': '\u21D9\u21D8 Merge FI',
    'setup': '\uD83D\uDD27 Setup',
    'prechecks': '\u2713 Prechecks',
    'work': '\u2699 Work',
    'commit': '\uD83D\uDCBE Commit',
    'postchecks': '\u2713 Postchecks',
    'merge-ri': '\u2197\u2199 Merge RI',
  };

  const tabs = phases.map(p => {
    return '<button class="attempt-phase-tab' + (p === 'all' ? ' active' : '') + '"'
      + ' data-phase="' + p + '" data-attempt="' + attemptNumber + '">'
      + (phaseLabels[p] || p) + '</button>';
  }).join('');

  const initialLog = logs['all'] || '';

  return '<div class="attempt-section">'
    + '<div class="attempt-section-title">\uD83D\uDCCB Logs</div>'
    + '<div class="attempt-phases" data-attempt="' + attemptNumber + '">'
    + '<div class="attempt-phase-tabs">' + tabs + '</div>'
    + '<pre class="attempt-log-viewer" data-attempt="' + attemptNumber + '">' + escapeHtml(initialLog) + '<\/pre>'
    + '<script type="application/json" class="attempt-logs-data" data-attempt="' + attemptNumber + '">'
    + JSON.stringify(logs)
    + '<\/script>'
    + '</div></div>';
}

// ─── Complete execution card ──────────────────────────────────────────────────

/**
 * Render a complete execution card HTML string.
 *
 * - `isLive: true` — main view card: wraps in `#liveExecutionCard`, includes step
 *   icon bar, and gives the metrics section `id="liveAiUsage"` for CSR updates.
 * - `isLive: false` (default) — attempt body content: returns the section HTML
 *   without an outer wrapper (the caller provides `.attempt-body`).
 *
 * @param data - Execution card data.
 * @returns HTML fragment string.
 */
export function executionCardHtml(data: ExecutionCardData): string {
  const ss = data.stepStatuses || {};
  const isRunning = data.status === 'running';

  const errSection = errorHtml(data.error, data.failureReason, data.lastPhase, data.exitCode);
  const metricsContent = metricsHtml(data.metrics);
  const ctxSection = contextHtml(data);
  const logsSection = data.logs ? logsSectionHtml(data.logs, data.attemptNumber) : '';
  const workSection = workSpecSectionHtml(data.task, data.workSpecHtml);

  if (data.isLive) {
    // Live main-view card — always expanded, with step icons + labeled metrics target
    const metricsSection = '<div class="attempt-section" id="liveAiUsage"'
      + (metricsContent ? '' : ' style="display:none;"')
      + '>'
      + (metricsContent
        ? '<div class="attempt-section-title">\uD83D\uDCCA AI Usage</div>' + metricsContent
        : '')
      + '</div>';

    return '<div id="liveExecutionCard" class="section execution-card-live">'
      + '<div class="step-indicators">' + phaseTabsHtml(ss, isRunning) + '</div>'
      + errSection
      + metricsSection
      + ctxSection
      + workSection
      + '</div>';
  }

  // Historical attempt body — no outer wrapper, caller provides .attempt-body
  const metricsSection = metricsContent
    ? '<div class="attempt-section">'
      + '<div class="attempt-section-title">\uD83D\uDCCA AI Usage</div>'
      + metricsContent
      + '</div>'
    : '';

  const hasBody = errSection || metricsContent || ctxSection || logsSection || workSection;
  const runningPlaceholder = !hasBody && isRunning
    ? '<div class="attempt-section">'
      + '<div class="attempt-running-indicator">\u27F3 Executing\u2026 see live log viewer above for current output.</div>'
      + '</div>'
    : '';

  return runningPlaceholder + errSection + metricsSection + ctxSection + workSection + logsSection;
}
