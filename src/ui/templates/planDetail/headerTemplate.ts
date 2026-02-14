/**
 * @fileoverview Plan detail header template.
 *
 * Renders the plan header section including plan name, duration timer,
 * and status badge. Also includes branch flow and capacity info sections.
 *
 * @module ui/templates/planDetail/headerTemplate
 */

import { escapeHtml, formatDurationMs } from '../helpers';

/**
 * Input data for rendering the plan detail header.
 */
export interface PlanHeaderData {
  /** Plan display name */
  planName: string;
  /** Computed plan status (e.g. 'running', 'succeeded', 'failed') */
  status: string;
  /** Epoch ms when the plan started */
  startedAt?: number;
  /** Epoch ms when the plan ended */
  effectiveEndedAt?: number;
  /** Base branch name */
  baseBranch: string;
  /** Target branch name (if set) */
  targetBranch?: string;
  /** Whether to show the branch flow section */
  showBranchFlow: boolean;
  /** Global capacity statistics */
  globalCapacityStats?: {
    thisInstanceJobs: number;
    totalGlobalJobs: number;
    globalMaxParallel: number;
    activeInstances: number;
  } | null;
}

/**
 * Format a plan's duration from start/end timestamps.
 *
 * @param startedAt - Epoch ms when the plan started.
 * @param endedAt - Epoch ms when the plan ended (uses Date.now() if omitted).
 * @returns Human-readable duration string, or '--' if startedAt is not set.
 */
export function formatPlanDuration(startedAt?: number, endedAt?: number): string {
  if (!startedAt) { return '--'; }
  const duration = (endedAt || Date.now()) - startedAt;
  return formatDurationMs(duration);
}

/**
 * Render the plan detail header HTML fragment.
 *
 * Includes the plan name heading, live duration counter, status badge,
 * optional branch flow bar, and optional capacity info bar.
 *
 * @param data - Header input data.
 * @returns HTML fragment string.
 */
export function renderPlanHeader(data: PlanHeaderData): string {
  const { planName, status, startedAt, effectiveEndedAt, baseBranch, targetBranch, showBranchFlow, globalCapacityStats } = data;
  const durationText = formatPlanDuration(startedAt, effectiveEndedAt);
  const targetBranchName = targetBranch || baseBranch;

  let html = `  <div class="header">
    <span class="status-badge ${status}" id="statusBadge"><span id="currentPhaseIndicator">${status}</span></span>
    <h2>${escapeHtml(planName)}</h2>
    <div class="header-duration">
      <span class="duration-icon">⏱</span>
      <span class="duration-value ${status}" id="planDuration" data-started="${startedAt || 0}" data-ended="${effectiveEndedAt || 0}" data-status="${status}">${durationText}</span>
    </div>
  </div>
  `;

  if (showBranchFlow) {
    html += `
  <div class="branch-flow">
    <span class="branch-label">Base:</span>
    <span class="branch-name">${escapeHtml(baseBranch)}</span>
    <span class="branch-arrow">→</span>
    <span class="branch-label">Work</span>
    <span class="branch-arrow">→</span>
    <span class="branch-label">Target:</span>
    <span class="branch-name">${escapeHtml(targetBranchName)}</span>
  </div>
  `;
  }

  html += `
  <div class="capacity-info capacity-badge" id="capacityInfo" style="display: none;">
    <span>🖥️ <span id="instanceCount">1</span> instance(s)</span>
    <span style="margin-left: 12px;">⚡ <span id="globalJobs">0</span>/<span id="globalMax">16</span> global</span>
  </div>
  `;

  return html;
}
