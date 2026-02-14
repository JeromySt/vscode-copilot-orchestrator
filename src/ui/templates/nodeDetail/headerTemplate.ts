/**
 * @fileoverview Node detail header HTML template.
 *
 * Generates HTML for the breadcrumb, node name, status badge,
 * execution state metadata, and error display sections.
 *
 * @module ui/templates/nodeDetail/headerTemplate
 */

import { escapeHtml, formatDurationMs } from '../helpers';

/**
 * Input data for the node detail header template.
 */
export interface HeaderData {
  /** Plan ID */
  planId: string;
  /** Plan display name */
  planName: string;
  /** Node display name */
  nodeName: string;
  /** Node type ('job' or 'sub-plan') */
  nodeType: string;
  /** Current node status */
  status: string;
  /** Number of execution attempts */
  attempts: number;
  /** Epoch timestamp when execution started */
  startedAt?: number;
  /** Epoch timestamp when execution ended */
  endedAt?: number;
  /** Copilot session ID */
  copilotSessionId?: string;
  /** Error message if failed */
  error?: string;
  /** Reason for failure */
  failureReason?: string;
  /** Phase that failed in last attempt */
  lastAttemptPhase?: string;
  /** Exit code from last attempt */
  lastAttemptExitCode?: number;
}

/**
 * Render the breadcrumb navigation bar.
 *
 * @param planId - The Plan ID for the navigation link.
 * @param planName - The Plan display name.
 * @param nodeName - The node display name.
 * @returns HTML fragment string.
 */
export function breadcrumbHtml(planId: string, planName: string, nodeName: string): string {
  return `<div class="breadcrumb">
    <a onclick="openPlan('${planId}')">${escapeHtml(planName)}</a> / ${escapeHtml(nodeName)}
  </div>`;
}

/**
 * Render the node name and status badge header row.
 * Layout matches the plan detail header: STATUS_BADGE | Name | Duration.
 *
 * @param nodeName - The node display name.
 * @param status - The current node status string.
 * @param startedAt - Epoch ms when execution started.
 * @param endedAt - Epoch ms when execution ended (uses Date.now() if running).
 * @returns HTML fragment string.
 */
export function headerRowHtml(nodeName: string, status: string, startedAt?: number, endedAt?: number): string {
  let durationText = '--';
  if (startedAt) {
    const elapsed = (endedAt || Date.now()) - startedAt;
    durationText = formatDurationMs(elapsed);
  }
  return `<div class="header">
    <span class="status-badge ${status}" id="node-status-badge">${status.toUpperCase()}</span>
    <h2>${escapeHtml(nodeName)}</h2>
    <div class="header-phase" id="header-phase-indicator" style="display:none;"></div>
    <div class="header-duration">
      <span class="duration-icon">⏱</span>
      <span class="duration-value ${status}" id="duration-timer"${startedAt ? ` data-started-at="${startedAt}"` : ''}${endedAt ? ` data-ended-at="${endedAt}"` : ''} data-status="${status}">${durationText}</span>
    </div>
  </div>`;
}

/**
 * Render the execution state metadata section.
 *
 * Includes node type, attempt count, start time, duration, copilot session,
 * error box, retry buttons, and force-fail section.
 *
 * @param data - The header data containing all state information.
 * @returns HTML fragment string for the execution state section.
 */
export function executionStateHtml(data: HeaderData): string {
  return `<div class="section">
    <h3>Execution State</h3>
    <div class="meta-grid">
      <div class="meta-item">
        <div class="meta-label">Type</div>
        <div class="meta-value">${data.nodeType === 'job' ? 'Job' : 'sub-plan'}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Attempts</div>
        <div class="meta-value">${data.attempts}${data.attempts > 1 ? ' ⟳' : ''}</div>
      </div>
      ${data.startedAt ? `
      <div class="meta-item">
        <div class="meta-label">Started</div>
        <div class="meta-value">${new Date(data.startedAt).toLocaleString()}</div>
      </div>
      ` : ''}
      ${data.copilotSessionId ? `
      <div class="meta-item full-width">
        <div class="meta-label">Copilot Session</div>
        <div class="meta-value session-id" data-session="${data.copilotSessionId}" title="Click to copy">
          ${data.copilotSessionId.substring(0, 12)}... 📋
        </div>
      </div>
      ` : ''}
    </div>
    ${data.error ? `
    <div class="error-box">
      <strong>${data.failureReason === 'crashed' ? 'Crashed:' : 'Error:'}</strong> 
      <span class="error-message ${data.failureReason === 'crashed' ? 'crashed' : ''}">${escapeHtml(data.error)}</span>
      ${data.lastAttemptPhase ? `<div class="error-phase">Failed in phase: <strong>${data.lastAttemptPhase}</strong></div>` : ''}
      ${data.lastAttemptExitCode !== undefined ? `<div class="error-phase">Exit code: <strong>${data.lastAttemptExitCode}</strong></div>` : ''}
    </div>
    ` : ''}
  </div>`;
}
