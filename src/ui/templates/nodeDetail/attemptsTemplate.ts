/**
 * @fileoverview Execution attempts HTML template for node detail panel.
 *
 * Generates HTML for the attempt history section with collapsible cards,
 * per-attempt phase tabs, and inline log viewers.
 *
 * @module ui/templates/nodeDetail/attemptsTemplate
 */

import { escapeHtml, formatDuration } from '../helpers';
import {
  phaseTabsHtml as executionPhaseTabsHtml,
  errorHtml as executionErrorHtml,
  contextHtml as executionContextHtml,
  splitAttemptLogs,
} from './executionCardTemplate';
import type { ExecutionCardData } from './executionCardTemplate';

/**
 * Per-phase step status mapping used in attempt records.
 */
export interface StepStatuses {
  'merge-fi'?: string;
  prechecks?: string;
  work?: string;
  commit?: string;
  postchecks?: string;
  'merge-ri'?: string;
}

/**
 * Work spec data for display in attempt context.
 */
export interface WorkSpecData {
  type?: string;
  [key: string]: any;
}

/**
 * Input data for a single attempt card.
 */
export interface AttemptCardData {
  attemptNumber: number;
  status: 'running' | 'succeeded' | 'failed' | 'canceled';
  triggerType?: 'initial' | 'auto-heal' | 'retry' | 'postchecks-revalidation';
  startedAt: number;
  endedAt: number;
  failedPhase?: string;
  error?: string;
  exitCode?: number;
  copilotSessionId?: string;
  stepStatuses?: StepStatuses;
  worktreePath?: string;
  baseCommit?: string;
  logFilePath?: string;
  /** Formatted work spec HTML (pre-rendered) */
  workUsedHtml?: string;
  /** Formatted prechecks spec HTML (pre-rendered) */
  prechecksUsedHtml?: string;
  /** Formatted postchecks spec HTML (pre-rendered) */
  postchecksUsedHtml?: string;
  /** Combined logs for this attempt */
  logs?: string;
  /** Pre-rendered metrics HTML */
  metricsHtml?: string;
}

/**
 * Input data for the attempt history section.
 */
export interface AttemptHistoryData {
  /** All attempt card data, in chronological order */
  attempts: AttemptCardData[];
}

/**
 * Build phase tabs for a specific historical attempt record.
 *
 * @deprecated Use `executionCardHtml` with pre-split `logs` instead.
 * @param attempt - The attempt data with logs.
 * @returns HTML fragment string for the phase tab UI, or empty string if no logs.
 */
export function attemptPhaseTabsHtml(attempt: AttemptCardData): string {
  if (!attempt.logs) {return '';}
  const phaseLogs = splitAttemptLogs(attempt.logs);

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

  const tabs = phases.map(p => {
    return '<button class="attempt-phase-tab' + (p === 'all' ? ' active' : '') + '"'
      + ' data-phase="' + p + '" data-attempt="' + attempt.attemptNumber + '">'
      + (phaseLabels[p] || p) + '</button>';
  }).join('');

  return '<div class="attempt-phases" data-attempt="' + attempt.attemptNumber + '">'
    + '<div class="attempt-phase-tabs">' + tabs + '</div>'
    + '<pre class="attempt-log-viewer" data-attempt="' + attempt.attemptNumber + '">' + escapeHtml(phaseLogs['all'] || '') + '<\/pre>'
    + '<script type="application/json" class="attempt-logs-data" data-attempt="' + attempt.attemptNumber + '">'
    + JSON.stringify(phaseLogs)
    + '<\/script>'
    + '</div>';
}

/**
 * Render a single attempt card.
 *
 * @param attempt - The attempt data.
 * @returns HTML fragment string for the attempt card.
 */
export function attemptCardHtml(attempt: AttemptCardData): string {
  const isRunning = attempt.status === 'running';
  const duration = isRunning
    ? formatDuration(Math.round((Date.now() - attempt.startedAt) / 1000)) + '…'
    : formatDuration(Math.round((attempt.endedAt - attempt.startedAt) / 1000));
  const timestamp = new Date(attempt.startedAt).toLocaleString();

  const statusColor = attempt.status === 'succeeded' ? '#4ec9b0'
    : attempt.status === 'failed' ? '#f48771'
    : attempt.status === 'running' ? '#3794ff'
    : '#858585';

  const statusIcon = attempt.status === 'succeeded' ? '\u2713'
    : attempt.status === 'failed' ? '\u2717'
    : attempt.status === 'running' ? '\u25B6'
    : '\u2298';

  const triggerLabel = attempt.triggerType === 'auto-heal' ? '\uD83D\uDD27 Auto-Heal'
    : attempt.triggerType === 'retry' ? '\uD83D\uDD04 Retry'
    : attempt.triggerType === 'postchecks-revalidation' ? '\uD83D\uDD0D Re-validation'
    : '';
  const triggerBadge = triggerLabel
    ? '<span class="attempt-trigger-badge">' + triggerLabel + '</span>'
    : '';

  const stepIcons = executionPhaseTabsHtml(attempt.stepStatuses as Record<string, string> || {}, isRunning);
  const stepIndicators = '<span class="step-indicators">' + stepIcons + '</span>';

  // ── Body sections using shared executionCardTemplate functions ──

  const errSection = executionErrorHtml(attempt.error, undefined, attempt.failedPhase, attempt.exitCode);

  const metricsSection = attempt.metricsHtml
    ? '<div class="attempt-section">'
      + '<div class="attempt-section-title">\uD83D\uDCCA AI Usage</div>'
      + attempt.metricsHtml
      + '</div>'
    : '';

  const ctxSection = executionContextHtml({
    copilotSessionId: attempt.copilotSessionId,
    baseCommit: attempt.baseCommit,
    worktreePath: attempt.worktreePath,
    logFilePath: attempt.logFilePath,
  } as Partial<ExecutionCardData>);

  const phaseTabsContent = attempt.logs ? attemptPhaseTabsHtml(attempt) : '';
  const logsSection = phaseTabsContent
    ? '<div class="attempt-section"><div class="attempt-section-title">\uD83D\uDCCB Logs</div>' + phaseTabsContent + '</div>'
    : '';

  const prechecksSection = attempt.prechecksUsedHtml
    ? '<div class="attempt-section"><div class="attempt-section-title">\uD83D\uDD0D Prechecks</div>' + attempt.prechecksUsedHtml + '</div>'
    : '';
  const workSection = attempt.workUsedHtml
    ? '<div class="attempt-section"><div class="attempt-section-title">\uD83D\uDCDD Work Spec</div>' + attempt.workUsedHtml + '</div>'
    : '';
  const postchecksSection = attempt.postchecksUsedHtml
    ? '<div class="attempt-section"><div class="attempt-section-title">\u2705 Postchecks</div>' + attempt.postchecksUsedHtml + '</div>'
    : '';

  const hasBodyContent = errSection || metricsSection || ctxSection || logsSection;
  const runningPlaceholder = !hasBodyContent && isRunning
    ? '<div class="attempt-section"><div class="attempt-running-indicator">\u27F3 Executing\u2026 see live log viewer above for current output.</div></div>'
    : '';

  return '<div class="attempt-card" data-attempt="' + attempt.attemptNumber + '" style="border-left: 3px solid ' + statusColor + ';">'
    + '<div class="attempt-header" data-expanded="false">'
    + '<div class="attempt-header-left">'
    + '<span class="attempt-status-icon" style="color:' + statusColor + ';">' + statusIcon + '</span>'
    + '<span class="attempt-badge">#' + attempt.attemptNumber + '</span>'
    + triggerBadge
    + stepIndicators
    + '</div>'
    + '<div class="attempt-header-right">'
    + '<span class="attempt-time">' + timestamp + '</span>'
    + '<span class="attempt-duration">' + duration + '</span>'
    + '<span class="attempt-chevron">\u203A</span>'
    + '</div>'
    + '</div>'
    + '<div class="attempt-body" style="display: none;">'
    + runningPlaceholder
    + errSection
    + metricsSection
    + ctxSection
    + prechecksSection
    + workSection
    + postchecksSection
    + logsSection
    + '</div>'
    + '</div>';
}

/**
 * Render the full attempt history section.
 *
 * Displays attempt cards in reverse chronological order (latest first).
 *
 * @param data - Attempt history input data.
 * @returns HTML fragment string, or empty string if no attempts.
 */
export function attemptHistoryHtml(data: AttemptHistoryData): string {
  if (!data.attempts || data.attempts.length === 0) {return '';}

  const cards = data.attempts.slice().reverse().map(attempt => attemptCardHtml(attempt)).join('');

  return `
    <div class="section">
      <h3>Attempt History (${data.attempts.length})</h3>
      ${cards}
    </div>
    `;
}
