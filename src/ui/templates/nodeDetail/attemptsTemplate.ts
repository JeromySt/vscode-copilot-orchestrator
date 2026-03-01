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
    const statusIcon = status === 'success' ? '✓' : status === 'failed' ? '✗' : status === 'skipped' ? '⊘' : '';
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
  const isRunning = attempt.status === 'running';
  const duration = isRunning 
    ? formatDuration(Math.round((Date.now() - attempt.startedAt) / 1000)) + '…'
    : formatDuration(Math.round((attempt.endedAt - attempt.startedAt) / 1000));
  const timestamp = new Date(attempt.startedAt).toLocaleString();

  const statusColor = attempt.status === 'succeeded' ? '#4ec9b0'
    : attempt.status === 'failed' ? '#f48771'
    : attempt.status === 'running' ? '#3794ff'
    : '#858585';

  const statusIcon = attempt.status === 'succeeded' ? '✓'
    : attempt.status === 'failed' ? '✗'
    : attempt.status === 'running' ? '▶'
    : '⊘';

  const triggerLabel = attempt.triggerType === 'auto-heal' ? '🔧 Auto-Heal'
    : attempt.triggerType === 'retry' ? '🔄 Retry'
    : attempt.triggerType === 'postchecks-revalidation' ? '🔍 Re-validation'
    : '';
  const triggerBadge = triggerLabel
    ? `<span class="attempt-trigger-badge">${triggerLabel}</span>`
    : '';

  const stepIndicators = `
        ${stepIconHtml(attempt.stepStatuses?.['merge-fi'])}
        ${stepIconHtml(attempt.stepStatuses?.prechecks)}
        ${stepIconHtml(attempt.stepStatuses?.work)}
        ${stepIconHtml(attempt.stepStatuses?.commit)}
        ${stepIconHtml(attempt.stepStatuses?.postchecks)}
        ${stepIconHtml(attempt.stepStatuses?.['merge-ri'])}
      `;

  // ── Expanded body sections ──

  const errorHtml = attempt.error
    ? `<div class="attempt-section attempt-error-section">
        <div class="attempt-section-title">❌ Error</div>
        <div class="attempt-error-body">
          <div class="attempt-error-msg">${escapeHtml(attempt.error)}</div>
          ${attempt.failedPhase ? `<div class="attempt-error-detail">Failed in phase: <strong>${attempt.failedPhase}</strong></div>` : ''}
          ${attempt.exitCode !== undefined ? `<div class="attempt-error-detail">Exit code: <strong>${attempt.exitCode}</strong></div>` : ''}
        </div>
      </div>`
    : '';

  const metricsHtml = attempt.metricsHtml
    ? `<div class="attempt-section">
        <div class="attempt-section-title">📊 AI Usage</div>
        ${attempt.metricsHtml}
      </div>`
    : '';

  const contextItems: string[] = [];
  if (attempt.baseCommit) {
    contextItems.push(`<div class="attempt-ctx-row"><span class="attempt-ctx-label">Base</span><code class="attempt-ctx-value">${attempt.baseCommit.slice(0, 8)}</code></div>`);
  }
  if (attempt.worktreePath) {
    contextItems.push(`<div class="attempt-ctx-row"><span class="attempt-ctx-label">Worktree</span><code class="attempt-ctx-value">${escapeHtml(attempt.worktreePath)}</code></div>`);
  }
  if (attempt.logFilePath) {
    contextItems.push(`<div class="attempt-ctx-row"><span class="attempt-ctx-label">Log</span><span class="log-file-path attempt-ctx-value" data-path="${escapeHtml(attempt.logFilePath)}" title="${escapeHtml(attempt.logFilePath)}">📄 ${escapeHtml(truncateLogPath(attempt.logFilePath))}</span></div>`);
  }
  if (attempt.copilotSessionId) {
    contextItems.push(`<div class="attempt-ctx-row"><span class="attempt-ctx-label">Session</span><span class="session-id attempt-ctx-value" data-session="${attempt.copilotSessionId}" title="Click to copy">${attempt.copilotSessionId.substring(0, 12)}… 📋</span></div>`);
  }
  const contextHtml = contextItems.length > 0
    ? `<div class="attempt-section"><div class="attempt-section-title">🔗 Context</div><div class="attempt-ctx-grid">${contextItems.join('')}</div></div>`
    : '';

  const prechecksHtml = attempt.prechecksUsedHtml
    ? `<div class="attempt-section"><div class="attempt-section-title">🔍 Prechecks</div>${attempt.prechecksUsedHtml}</div>`
    : '';

  const workHtml = attempt.workUsedHtml
    ? `<div class="attempt-section"><div class="attempt-section-title">📝 Work Spec</div>${attempt.workUsedHtml}</div>`
    : '';

  const postchecksHtml = attempt.postchecksUsedHtml
    ? `<div class="attempt-section"><div class="attempt-section-title">✅ Postchecks</div>${attempt.postchecksUsedHtml}</div>`
    : '';

  const phaseTabsHtml = attempt.logs ? attemptPhaseTabsHtml(attempt) : '';
  const logsHtml = phaseTabsHtml
    ? `<div class="attempt-section"><div class="attempt-section-title">📋 Logs</div>${phaseTabsHtml}</div>`
    : '';

  // For running attempts with no content sections, show a status indicator
  // so the expanded body isn't completely empty
  const hasBodyContent = errorHtml || metricsHtml || contextItems.length > 0 || 
    prechecksHtml || workHtml || postchecksHtml || logsHtml;
  const runningPlaceholder = (!hasBodyContent && isRunning)
    ? `<div class="attempt-section"><div class="attempt-running-indicator">⟳ Executing… see live log viewer above for current output.</div></div>`
    : '';

  return `
        <div class="attempt-card" data-attempt="${attempt.attemptNumber}" style="border-left: 3px solid ${statusColor};">
          <div class="attempt-header" data-expanded="false">
            <div class="attempt-header-left">
              <span class="attempt-status-icon" style="color:${statusColor};">${statusIcon}</span>
              <span class="attempt-badge">#${attempt.attemptNumber}</span>
              ${triggerBadge}
              <span class="step-indicators">${stepIndicators}</span>
            </div>
            <div class="attempt-header-right">
              <span class="attempt-time">${timestamp}</span>
              <span class="attempt-duration">${duration}</span>
              <span class="attempt-chevron">›</span>
            </div>
          </div>
          <div class="attempt-body" style="display: none;">
            ${runningPlaceholder}
            ${errorHtml}
            ${metricsHtml}
            ${contextHtml}
            ${prechecksHtml}
            ${workHtml}
            ${postchecksHtml}
            ${logsHtml}
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
