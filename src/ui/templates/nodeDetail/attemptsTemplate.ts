/**
 * @fileoverview Execution attempts HTML template for node detail panel.
 *
 * Generates HTML for the attempt history section with collapsible cards,
 * per-attempt phase tabs, and inline log viewers.
 *
 * @module ui/templates/nodeDetail/attemptsTemplate
 */

import { escapeHtml, formatDuration } from '../helpers';

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
  status: 'succeeded' | 'failed' | 'canceled';
  triggerType?: 'initial' | 'auto-heal' | 'retry';
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
 * Truncate a log file path for display in attempt context.
 *
 * @param filePath - Full path to log file.
 * @returns Truncated display string.
 */
function truncateLogPath(filePath: string): string {
  if (!filePath) {return '';}

  const separator = filePath.includes('\\') ? '\\' : '/';
  const parts = filePath.split(separator);
  const filename = parts[parts.length - 1];
  const prefix = parts[0] + separator;

  let truncatedFilename = filename;
  const logMatch = filename.match(/^([a-f0-9]{8})-[a-f0-9-]+_[a-f0-9-]+-([a-f0-9]{12})_(\d+\.log)$/i);
  if (logMatch) {
    truncatedFilename = `${logMatch[1]}....${logMatch[2]}_${logMatch[3]}`;
  }

  if (filePath.length <= 50) {return filePath;}

  return `${prefix}....${separator}${truncatedFilename}`;
}

/**
 * Map a step status to a Unicode icon wrapped in a span.
 *
 * @param status - The step status string.
 * @returns HTML span with icon and status CSS class.
 */
function stepIconHtml(status?: string): string {
  const icon = status === 'success' ? '✓'
    : status === 'failed' ? '✗'
    : status === 'running' ? '⟳'
    : status === 'skipped' ? '⊘'
    : '○';
  return `<span class="step-icon ${status || 'pending'}">${icon}</span>`;
}

/**
 * Build phase tabs for a specific historical attempt record.
 *
 * @param attempt - The attempt data with logs.
 * @returns HTML fragment string for the phase tab UI, or empty string if no logs.
 */
export function attemptPhaseTabsHtml(attempt: AttemptCardData): string {
  if (!attempt.logs) {return '';}

  const logs = attempt.logs;
  const phases = ['all', 'merge-fi', 'prechecks', 'work', 'commit', 'postchecks', 'merge-ri'] as const;

  const phaseLabels: Record<string, string> = {
    'all': '📄 Full Log',
    'merge-fi': '↙↘ Merge FI',
    'prechecks': '✓ Prechecks',
    'work': '⚙ Work',
    'commit': '💾 Commit',
    'postchecks': '✓ Postchecks',
    'merge-ri': '↗↙ Merge RI',
  };

  const getPhaseStatus = (phase: string): string => {
    if (phase === 'all') {return '';}
    const status = (attempt.stepStatuses as any)?.[phase];
    if (status === 'success') {return 'success';}
    if (status === 'failed') {return 'failed';}
    if (status === 'skipped') {return 'skipped';}
    return '';
  };

  const tabs = phases.map(phase => {
    const status = getPhaseStatus(phase);
    const statusIcon = status === 'success' ? '✓' : status === 'failed' ? '✗' : status === 'skipped' ? '○' : '';
    return `<button class="attempt-phase-tab ${phase === 'all' ? 'active' : ''} ${status}" 
                    data-phase="${phase}" data-attempt="${attempt.attemptNumber}">
              ${statusIcon} ${phaseLabels[phase]}
            </button>`;
  }).join('');

  const extractPhaseLogs = (phase: string): string => {
    if (phase === 'all') {return logs;}

    const phaseMarkers: Record<string, string> = {
      'merge-fi': 'FORWARD INTEGRATION',
      'prechecks': 'PRECHECKS',
      'work': 'WORK',
      'commit': 'COMMIT',
      'postchecks': 'POSTCHECKS',
      'merge-ri': 'REVERSE INTEGRATION',
    };

    const marker = phaseMarkers[phase];
    if (!marker) {return '';}

    const startPattern = new RegExp(`=+ ${marker}.*START =+`, 'i');
    const endPattern = new RegExp(`=+ ${marker}.*END =+`, 'i');

    const startMatch = logs.match(startPattern);
    const endMatch = logs.match(endPattern);

    if (startMatch && endMatch) {
      const startIdx = logs.indexOf(startMatch[0]);
      const endIdx = logs.indexOf(endMatch[0]) + endMatch[0].length;
      return logs.slice(startIdx, endIdx);
    }

    const lines = logs.split('\n');
    const filtered = lines.filter(line => {
      const upper = line.toUpperCase();
      return upper.includes(`[${phase.toUpperCase()}]`) || upper.includes(marker);
    });
    return filtered.length > 0 ? filtered.join('\n') : `No logs for ${phase} phase.`;
  };

  const phaseLogsData: Record<string, string> = {};
  phases.forEach(p => phaseLogsData[p] = extractPhaseLogs(p));

  return `
      <div class="attempt-phases" data-attempt="${attempt.attemptNumber}">
        <div class="attempt-phase-tabs">${tabs}</div>
        <pre class="attempt-log-viewer" data-attempt="${attempt.attemptNumber}">${escapeHtml(phaseLogsData['all'])}</pre>
        <script type="application/json" class="attempt-logs-data" data-attempt="${attempt.attemptNumber}">
          ${JSON.stringify(phaseLogsData)}
        </script>
      </div>
    `;
}

/**
 * Render a single attempt card.
 *
 * @param attempt - The attempt data.
 * @returns HTML fragment string for the attempt card.
 */
export function attemptCardHtml(attempt: AttemptCardData): string {
  const duration = formatDuration(Math.round((attempt.endedAt - attempt.startedAt) / 1000));
  const timestamp = new Date(attempt.startedAt).toLocaleString();

  const stepIndicators = `
        ${stepIconHtml(attempt.stepStatuses?.['merge-fi'])}
        ${stepIconHtml(attempt.stepStatuses?.prechecks)}
        ${stepIconHtml(attempt.stepStatuses?.work)}
        ${stepIconHtml(attempt.stepStatuses?.commit)}
        ${stepIconHtml(attempt.stepStatuses?.postchecks)}
        ${stepIconHtml(attempt.stepStatuses?.['merge-ri'])}
      `;

  const sessionHtml = attempt.copilotSessionId
    ? `<div class="attempt-meta-row"><strong>Session:</strong> <span class="session-id" data-session="${attempt.copilotSessionId}" title="Click to copy">${attempt.copilotSessionId.substring(0, 12)}... 📋</span></div>`
    : '';

  const errorHtml = attempt.error
    ? `<div class="attempt-error">
            <strong>Error:</strong> <span class="error-message">${escapeHtml(attempt.error)}</span>
            ${attempt.failedPhase ? `<div style="margin-top: 4px;">Failed in phase: <strong>${attempt.failedPhase}</strong></div>` : ''}
            ${attempt.exitCode !== undefined ? `<div>Exit code: <strong>${attempt.exitCode}</strong></div>` : ''}
           </div>`
    : '';

  const attemptLogFileHtml = attempt.logFilePath
    ? `<div class="attempt-meta-row"><strong>Log:</strong> <span class="log-file-path" data-path="${escapeHtml(attempt.logFilePath)}" title="${escapeHtml(attempt.logFilePath)}">📄 ${escapeHtml(truncateLogPath(attempt.logFilePath))}</span></div>`
    : '';

  const contextHtml = (attempt.worktreePath || attempt.baseCommit || attempt.workUsedHtml || attempt.logFilePath)
    ? `<div class="attempt-context">
            ${attempt.baseCommit ? `<div class="attempt-meta-row"><strong>Base:</strong> <code>${attempt.baseCommit.slice(0, 8)}</code></div>` : ''}
            ${attempt.worktreePath ? `<div class="attempt-meta-row"><strong>Worktree:</strong> <code>${escapeHtml(attempt.worktreePath)}</code></div>` : ''}
            ${attemptLogFileHtml}
            ${attempt.workUsedHtml ? `<div class="attempt-meta-row attempt-work-row"><strong>Work:</strong> <div class="attempt-work-content">${attempt.workUsedHtml}</div></div>` : ''}
           </div>`
    : '';

  const triggerBadge = attempt.triggerType === 'auto-heal'
    ? '<span class="trigger-badge auto-heal">🔧 Auto-Heal</span>'
    : attempt.triggerType === 'retry'
      ? '<span class="trigger-badge retry">🔄 Retry</span>'
      : '';

  const phaseTabsHtml = attempt.logs ? attemptPhaseTabsHtml(attempt) : '';

  return `
        <div class="attempt-card" data-attempt="${attempt.attemptNumber}">
          <div class="attempt-header" data-expanded="false">
            <div class="attempt-header-left">
              <span class="attempt-badge">#${attempt.attemptNumber}</span>
              ${triggerBadge}
              <span class="step-indicators">${stepIndicators}</span>
              <span class="attempt-time">${timestamp}</span>
              <span class="attempt-duration">(${duration})</span>
            </div>
            <span class="chevron">▶</span>
          </div>
          <div class="attempt-body" style="display: none;">
            <div class="attempt-meta">
              <div class="attempt-meta-row"><strong>Status:</strong> <span class="status-${attempt.status}">${attempt.status}</span></div>
              ${sessionHtml}
            </div>
            ${attempt.metricsHtml || ''}
            ${contextHtml}
            ${errorHtml}
            ${phaseTabsHtml}
          </div>
        </div>
      `;
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
